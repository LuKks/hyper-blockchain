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
if (!key) throw new Error('node miner.js <core-key>')

const core = new Hypercore(RAM, HypercoreId.decode(key), { valueEncoding: c.any })

main().catch(err => {
  console.error(err)
  process.exit(1)
})

async function main () {
  await core.ready()

  const seed = await getPrimaryKey('./miner-primary-key')
  console.log(seed)

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
  let complexity = await rpc.request(core.key, 'complexity')

  while (true) {
    // TODO: Being able to cancel current solving i.e. complexity changed
    // TODO: Callback for each internal iteration for when it's slow to solve it
    const nonce = solver.solve(complexity, core.key)

    console.log('Submit', nonce.toString('hex'))
    const block = await rpc.request(core.key, 'submit', { nonce })

    if (!block) {
      console.log('Failed to submit', { nonce: nonce.toString('hex'), complexity })

      // Assume complexity changed, this can waste a lot of CPU because server should push you the new complexity on change
      complexity = await rpc.request(core.key, 'complexity')
      console.log('Maybe new complexity', complexity)

      continue
    }

    console.log('Block added!', { index: block, complexity })
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
