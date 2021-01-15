# USM - DIA

This is a fork of USM using DIA oracles. Changes added:
- `DiaOracle.sol` as an external contract, with some changes in order to use the same compiler as the rest of the project.
- `DiaOracleAdapter.sol`: A contract implementing USMs Oracle API and consuming a DIA oracle
- `USMDIA.sol`: A contract that implements USMTemplate and DiaOracleAdapter. This is the contract we care about most of the time
- Disabled the Proxy for simplicity.

## deployed contracts
- [DiaOracle](https://kovan.etherscan.io/address/0x559C34610e06526c31c9d4E3d03E86b56EcC9CA4), implement's dia oracle API.

- [USMDIA](https://kovan.etherscan.io/address/0xB1075F59F9A7ABc2784925AE488aDC5842f080a4): the synthetic asset. It tracks the US dollar, so no changes from USM there.

Both contracts are verified on Etherscan so you can play with them. [FUM](https://kovan.etherscan.io/address/0x6c4ca030b6be85edb7847e1bf00080ca18c253f6) is not, however (TODO). The main points of interest would be USMDIA's `fund`, `defund`, `mint` and `burn` functions.

## What we expect from the oracle

The oracle must return a 18-decimal fixed-point uint256 representing the price of the collateral (for now always ETH) in terms of the synthetic. Examples:

- synthetic of USD, price of ETH $1200: `1200000000000000000000`
- synthetic of USD, price of ETH $800: `800000000000000000000`
- synthetic of Argetine Peso, price of ETH AR$185000: `185000000000000000000000`

The 'ticker' is used in the name and symbol of the token, and is formatted as `collateral/synthetic`, so the deployed USMDIA is called `DIA synthetic for tickerETH/USD` and has symbol: `DIA-ETH/USD`.
