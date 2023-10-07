#!/usr/bin/env node

const fs = require('fs')
const Hypercore = require('hypercore')
const RAM = require('random-access-memory')
// const Hyperswarm = require('hyperswarm')
const RPC = require('@hyperswarm/rpc')
const c = require('compact-encoding')
const HypercoreId = require('hypercore-id-encoding')
const crypto = require('hypercore-crypto')
const goodbye = require('graceful-goodbye')
const pow = require('proof-of-work')

const key = process.argv[2]
if (!key) throw new Error('hyper-blockchain-miner <core-key>')

const core = new Hypercore(RAM, HypercoreId.decode(key), { valueEncoding: c.any })

main().catch(err => {
  console.error(err)
  process.exit(1)
})

async function main () {
  await core.ready()

  const seed = await getPrimaryKey('./miner-primary-key')

  /* const done = core.findingPeers()
  const swarm = new Hyperswarm()
  swarm.on('connection', c => core.replicate(c))
  swarm.join(core.discoveryKey)
  swarm.flush().then(done, done) */

  const solver = new pow.Solver()

  const rpc = new RPC({
    seed,
    valueEncoding: c.any // TODO
  })

  console.log('Miner public key', HypercoreId.encode(rpc.defaultKeyPair.publicKey))

  goodbye(() => rpc.destroy())

  while (true) {
    try {
      await run(rpc, solver)
    } catch (err) {
      // Retry on errors (silly retry because it currently loses the solved nonce if any)
      if (err.code === 'CHANNEL_DESTROYED' || err.code === 'CHANNEL_CLOSED') {
        console.error('Retrying..', err.message)
        await new Promise(resolve => setTimeout(resolve, 2000))
        continue
      }

      throw err
    }
  }
}

async function run (rpc, solver) {
  let complexity = await request(rpc, 'complexity')

  while (true) {
    const started = Date.now()

    // TODO: Being able to cancel current solving to save CPU i.e. complexity changed
    // TODO: Callback for each internal iteration for logging progress
    const nonce = solver.solve(complexity, core.key)

    console.log('Submit', nonce.toString('hex'), 'Time spent', Date.now() - started)
    const added = await request(rpc, 'submit', { nonce })

    if (!added) {
      console.log('Failed to submit', { nonce: nonce.toString('hex'), complexity })

      // Assume complexity changed, this already wasted a lot of CPU because server should push you the new complexity on change
      complexity = await request(rpc, 'complexity')
      console.log('Maybe new complexity', complexity)

      continue
    }

    console.log('Block added!', added.block)

    if (added.complexityChanged) {
      complexity = await request(rpc, 'complexity')
      console.log('New complexity', complexity)
    }
  }
}

// One-time retry
async function request (rpc, method, value, options) {
  try {
    return await rpc.request(core.key, method, value, options)
  } catch (err) {
    if (err.code !== 'CHANNEL_DESTROYED' && err.code !== 'CHANNEL_CLOSED') {
      throw err
    }
    return await rpc.request(core.key, method, value, options)
  }
}

async function getPrimaryKey (filename) {
  try {
    const seed = await fs.promises.readFile(filename, 'utf8')

    return Buffer.from(seed, 'hex')
  } catch (err) {
    if (err.code !== 'ENOENT') throw err

    const seed = crypto.randomBytes(32)

    await fs.promises.writeFile(filename, seed.toString('hex') + '\n', { flag: 'wx' })

    return seed
  }
}
