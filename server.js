#!/usr/bin/env node

const Hypercore = require('hypercore')
const Hyperbee = require('hyperbee')
const Hyperswarm = require('hyperswarm')
const RPC = require('@hyperswarm/rpc')
const c = require('compact-encoding')
const HypercoreId = require('hypercore-id-encoding')
const mutexify = require('mutexify/promise')
const goodbye = require('graceful-goodbye')
const pow = require('proof-of-work')

const AVG_BLOCK_TIME = 15 * 1000 // Average block time is ~15 seconds
const AVG_BLOCKS = (24 * 60 * 60 * 1000) / AVG_BLOCK_TIME // Adjusted every "~24 hours" equivalent in amount of blocks

const core = new Hypercore('./blockchain-data', { cache: true, valueEncoding: c.any })
const db = new Hyperbee(new Hypercore('./blockchain-database', { cache: true, keyEncoding: c.any, valueEncoding: c.any }))

const lock = mutexify()
let complexity = 0

main().catch(err => {
  console.error(err)
  process.exit(1)
})

async function main () {
  await core.ready()
  await db.ready()

  console.log('Core length', core.length)

  // Sync chain nonces (optimization for fast submits)
  // Alternatively, it could just be a "Hyperbee chain"
  console.log('Syncing chain..')
  for await (const block of core.createReadStream()) {
    const entry = await db.get(block.nonce)
    if (!entry) await db.put(block.nonce)
  }
  console.log('Chain synced')

  const swarm = new Hyperswarm()
  swarm.on('connection', c => core.replicate(c))
  swarm.join(core.discoveryKey)

  complexity = await getComplexity()
  await maybeAdjustComplexity()

  // We should find a simpler PoW system so we don't need to check past nonces
  const verifier = new pow.Verifier({
    prefix: core.key,
    validity: Infinity, // TODO
    size: 0, // TODO: With 1024 after lots of checks it starts rejecting them all, don't know why
    n: 16
  })

  const rpc = new RPC({
    keyPair: core.keyPair,
    valueEncoding: c.any // TODO
  })

  const server = rpc.createServer()

  server.respond('submit', async function (req, rpc) {
    const release = await lock()

    try {
      const isValid = await checkNonce(verifier, req.nonce, complexity)
      if (!isValid) return null // TODO: Server should ban the IP of peers that submits many wrong nonces, first miner.js should try to avoid it

      // TODO: Allow user to put any random data it wants
      // TODO: Add a hash of the previous block?
      const block = await core.append({
        nonce: req.nonce,
        complexity,
        time: Date.now(),
        by: rpc.mux.stream.remotePublicKey
      })

      const pk = rpc.mux.stream.remotePublicKey.subarray(0, 8).toString('hex') + '..'
      console.log('New length', core.length, 'Complexity', complexity, 'Thanks to', pk)

      const complexityChanged = await maybeAdjustComplexity()

      return {
        block: { index: block.length - 1 },
        complexityChanged
      }
    } finally {
      release()
    }
  })

  server.respond('complexity', function (req) {
    return complexity
  })

  await server.listen()

  console.log('Server public key:', HypercoreId.encode(server.publicKey))

  goodbye(async function () {
    await server.close()
    await rpc.destroy()
    await core.close()
  })
}

async function getComplexity () {
  if (core.length === 0) return 1

  const lastBlock = await core.get(core.length - 1)
  return lastBlock.complexity
}

async function complexityInfo () {
  const start = Math.max(0, core.length - AVG_BLOCKS)
  const end = core.length

  const blocks = []
  let lastBlock = null
  let averageTime = 0

  for await (const block of core.createReadStream({ start, end })) {
    blocks.push(block)
  }

  if (blocks.length >= 2) {
    lastBlock = blocks[blocks.length - 1]

    let total = 0

    for (let i = 1; i < blocks.length; i++) {
      total += blocks[i].time - blocks[i - 1].time
    }

    averageTime = total / (blocks.length - 1)
  }

  // console.log('complexityInfo', { averageTime })

  return { averageTime, lastBlock }
}

function adjustComplexity ({ averageTime, lastBlock }) {
  if (averageTime === 0) return 1

  if (averageTime === AVG_BLOCK_TIME) {
    return lastBlock.complexity
  }

  if (averageTime > AVG_BLOCK_TIME) {
    return Math.max(1, lastBlock.complexity - 1)
  }

  return lastBlock.complexity + 1
}

async function maybeAdjustComplexity () {
  if (core.length === 0) return false

  console.log('Maybe adjust complexity', { AVG_BLOCK_TIME, AVG_BLOCKS }, 'Round', core.length % AVG_BLOCKS)

  if (core.length % AVG_BLOCKS === 0) {
    console.log('Adjusting complexity', complexity)

    const currentComplexityInfo = await complexityInfo()
    const nextComplexity = adjustComplexity(currentComplexityInfo)
    console.log('Next complexity', nextComplexity)

    complexity = nextComplexity

    return true
  }

  return false
}

async function checkNonce (verifier, nonce, complexity) {
  // console.log('checkNonce', { nonce: nonce.toString('hex'), complexity })

  const isValid = verifier.check(nonce, complexity)
  if (!isValid) {
    console.log('Nonce is invalid (verifier failed)')
    return false
  }

  // Optimization to avoid reading all past blocks (it doesn't need batch, there is an external lock)
  const entry = await db.get(nonce)
  if (entry) {
    console.log('Nonce already used (cache hit)')
    return false
  }
  await db.put(nonce)

  // console.log('Checking past nonces')

  // Server can be restarted along with the internal bloom filters of the verifier
  // So we manually check past nonces
  /* for await (const block of core.createReadStream()) {
    console.log('Check past nonce', block)

    // TODO: Use `cas`
    if (!(await db.get(block.nonce))) await db.put(block.nonce)

    // Don't know if this is correct, we allow the same nonce as long as it has a different complexity
    // Otherwise, we could just reject same nonces
    if (block.nonce === nonce) { // && block.complexity <= complexity
      console.log('Nonce already exists', nonce)
      return false
    }
  } */

  // console.log('Nonce is valid and unique!')

  return true
}
