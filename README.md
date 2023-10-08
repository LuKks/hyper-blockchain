# hyper-blockchain

Proof of Work with Hypercore (experiment)

## Install

```
npm i -g hyper-blockchain
```

## Create a blockchain

Run a server, it will create two folders `./blockchain-data/` and `./blockchain-database/`

```
hyper-blockchain-server [--storage <path>]
```

## Run a miner

Run a single miner, it will create a `./miner-primary-key` file

`hyper-blockchain-miner <core-key> [--storage <path>]`

Now get more people to mine your Hypercore! :)

## License

MIT
