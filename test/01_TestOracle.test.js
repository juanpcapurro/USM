const { BN } = require('@openzeppelin/test-helpers')

const TestOracle = artifacts.require('TestOracle')
const DiaOracle = artifacts.require('DiaOracle')
const DiaOracleAdapter = artifacts.require('DiaOracleAdapter')

const Aggregator = artifacts.require('MockChainlinkAggregatorV3')
const ChainlinkOracle = artifacts.require('ChainlinkOracle')

const UniswapAnchoredView = artifacts.require('MockUniswapAnchoredView')
const CompoundOracle = artifacts.require('CompoundOpenOracle')

const UniswapV2Pair = artifacts.require('MockUniswapV2Pair')
const UniswapTWAPOracle = artifacts.require('OurUniswapV2TWAPOracle')

const MedianOracle = artifacts.require('MedianOracle')

const GasMeasuredOracleWrapper = artifacts.require('GasMeasuredOracleWrapper')

require('chai').use(require('chai-as-promised')).should()

contract('Oracle pricing', (accounts) => {
  const testPriceWAD = '250000000000000000000' // TestOracle just uses WAD (18-dec-place) pricing

  const chainlinkPrice = '38598000000' // Chainlink aggregator (AggregatorV3Interface) stores 8 dec places
  const chainlinkPriceWAD = new BN(chainlinkPrice + '0000000000') // We want 18 dec places, so add 10 0s

  const compoundPrice = '414174999' // Compound view (UniswapAnchoredView) stores 6 dec places
  const compoundPriceWAD = new BN(compoundPrice + '000000000000') // We want 18 dec places, so add 12 0s

  const ethDecimals = new BN(18) // See OurUniswapV2TWAPOracle
  const usdtDecimals = new BN(6)
  const usdcDecimals = new BN(6)
  const uniswapCumPriceScalingFactor = new BN(2).pow(new BN(112))

  const ethUsdtCumPrice0_0 = new BN('30197009659458262808281833965635') // From the ETH/USDT pair.  See OurUniswapV2TWAPOracle
  const ethUsdtCumPrice1_0 = new BN('276776388531768266239160661937116320880685460468473')
  const ethUsdtTimestamp_0 = new BN('1606780564')
  const ethUsdtCumPrice0_1 = new BN('30198349396553956234684790868151')
  const ethUsdtCumPrice1_1 = new BN('276779938284455484990752289414970402581013223198265')
  const ethUsdtTimestamp_1 = new BN('1606780984')
  const ethUsdtTokensInReverseOrder = false
  const ethUsdtScaleFactor = new BN(10).pow(ethDecimals.add(new BN(18)).sub(usdtDecimals))

  const usdcEthCumPrice0_0 = new BN('307631784275278277546624451305316303382174855535226') // From the USDC/ETH pair
  const usdcEthCumPrice1_0 = new BN('31377639132666967530700283664103')
  const usdcEthTimestamp_0 = new BN('1606780664')
  const usdcEthCumPrice0_1 = new BN('307634635050611880719301156089846577363471806696356')
  const usdcEthCumPrice1_1 = new BN('31378725947216452626380862836246')
  const usdcEthTimestamp_1 = new BN('1606781003')
  const usdcEthTokensInReverseOrder = true

  function median(a, b, c) {
    const ab = a > b
    const bc = b > c
    const ca = c > a
    return ca == ab ? a : ab == bc ? b : c
  }

  describe('with TestOracle', () => {
    const [deployer] = accounts
    let oracle

    beforeEach(async () => {
      oracle = await TestOracle.new(testPriceWAD, { from: deployer })
      oracle = await GasMeasuredOracleWrapper.new(oracle.address, 'test', { from: deployer })
    })

    it('returns the correct price', async () => {
      const oraclePrice = await oracle.latestPrice()
      oraclePrice.toString().should.equal(testPriceWAD)
    })
  })

  describe('with ChainlinkOracle', () => {
    const [deployer] = accounts
    let oracle
    let aggregator

    beforeEach(async () => {
      aggregator = await Aggregator.new({ from: deployer })
      await aggregator.set(chainlinkPrice)

      oracle = await ChainlinkOracle.new(aggregator.address, { from: deployer })
      oracle = await GasMeasuredOracleWrapper.new(oracle.address, 'chainlink', { from: deployer })
    })

    it('returns the correct price', async () => {
      const oraclePrice = await oracle.latestPrice()
      oraclePrice.toString().should.equal(chainlinkPriceWAD.toString())
    })
  })

  describe('with CompoundOracle', () => {
    const [deployer] = accounts
    let oracle
    let anchoredView

    beforeEach(async () => {
      anchoredView = await UniswapAnchoredView.new({ from: deployer })
      await anchoredView.set(compoundPrice)

      oracle = await CompoundOracle.new(anchoredView.address, { from: deployer })
      oracle = await GasMeasuredOracleWrapper.new(oracle.address, 'compound', { from: deployer })
    })

    it('returns the correct price', async () => {
      const oraclePrice = await oracle.latestPrice()
      oraclePrice.toString().should.equal(compoundPriceWAD.toString())
    })
  })

  describe('with OurUniswapV2TWAPOracle', () => {
    const [deployer] = accounts
    let oracle
    let pair

    beforeEach(async () => {
      pair = await UniswapV2Pair.new({ from: deployer })
      await pair.setReserves(0, 0, ethUsdtTimestamp_0)
      await pair.setCumulativePrices(ethUsdtCumPrice0_0, ethUsdtCumPrice1_0)

      oracle = await UniswapTWAPOracle.new(pair.address, ethDecimals, usdtDecimals, ethUsdtTokensInReverseOrder, {
        from: deployer,
      })
      oracle = await GasMeasuredOracleWrapper.new(oracle.address, 'uniswapTWAP', { from: deployer })
      await oracle.cacheLatestPrice()

      await pair.setReserves(0, 0, ethUsdtTimestamp_1)
      await pair.setCumulativePrices(ethUsdtCumPrice0_1, ethUsdtCumPrice1_1)
      //await oracle.cacheLatestPrice() // Not actually needed, unless we do further testing moving timestamps further forward
    })

    it('returns the correct price', async () => {
      const oraclePrice1 = await oracle.latestPrice()

      const targetOraclePriceNum = ethUsdtCumPrice0_1.sub(ethUsdtCumPrice0_0).mul(ethUsdtScaleFactor)
      const targetOraclePriceDenom = ethUsdtTimestamp_1.sub(ethUsdtTimestamp_0).mul(uniswapCumPriceScalingFactor)
      const targetOraclePrice1 = targetOraclePriceNum.div(targetOraclePriceDenom)
      oraclePrice1.toString().should.equal(targetOraclePrice1.toString())
    })
  })

  describe('with MedianOracle', () => {
    const [deployer] = accounts
    let rawOracle, oracle
    let chainlinkAggregator, compoundView, usdcEthPair

    beforeEach(async () => {
      chainlinkAggregator = await Aggregator.new({ from: deployer })
      await chainlinkAggregator.set(chainlinkPrice)

      compoundView = await UniswapAnchoredView.new({ from: deployer })
      await compoundView.set(compoundPrice)

      usdcEthPair = await UniswapV2Pair.new({ from: deployer })
      await usdcEthPair.setReserves(0, 0, usdcEthTimestamp_0)
      await usdcEthPair.setCumulativePrices(usdcEthCumPrice0_0, usdcEthCumPrice1_0)

      rawOracle = await MedianOracle.new(
        chainlinkAggregator.address,
        compoundView.address,
        usdcEthPair.address,
        usdcDecimals,
        ethDecimals,
        usdcEthTokensInReverseOrder,
        { from: deployer }
      )
      oracle = await GasMeasuredOracleWrapper.new(rawOracle.address, 'median', { from: deployer })
      await oracle.cacheLatestPrice()

      await usdcEthPair.setReserves(0, 0, usdcEthTimestamp_1)
      await usdcEthPair.setCumulativePrices(usdcEthCumPrice0_1, usdcEthCumPrice1_1)
      //await oracle.cacheLatestPrice() // Not actually needed, unless we do further testing moving timestamps further forward
    })

    it('returns the correct price', async () => {
      const oraclePrice = await oracle.latestPrice()
      const uniswapPrice = await rawOracle.latestUniswapTWAPPrice()
      const targetOraclePrice = median(chainlinkPriceWAD, compoundPriceWAD, uniswapPrice)
      oraclePrice.toString().should.equal(targetOraclePrice.toString())
    })
  })

  describe.only('with DiaOracle', () => {
    const [deployer] = accounts
    const coinName = 'ETH/USD'
    const ethPrice = '1120000000000000000000'
    let oracle
    const now = Date.now().toString()
    before(async () => {
      oracle = await DiaOracle.new({ from: deployer })
    })
    describe('WHEN asking for a non-set price', () => {
      let coinInfo
      before(async () => {
        coinInfo = await oracle.getCoinInfo(coinName)
      })
      it('THEN price is zero', () => {
        const price = coinInfo[0]
        const supply = coinInfo[1]
        const lastUpdateTimestamp = coinInfo[2]
        const symbol = coinInfo[3]
        price.toString().should.equal('0')
        supply.toString().should.equal('0')
        lastUpdateTimestamp.toString().should.equal('0')
        symbol.should.equal('')
      })
    })
    describe('GIVEN a DIA oracle adapter', () => {
      let adapter
      before(async () => {
        oracle = await DiaOracle.new({ from: deployer })
        adapter = await DiaOracleAdapter.new(oracle.address, coinName)
        await oracle.updateCoinInfo(coinName, 'ETH/USD', ethPrice, '4', now)
      })
      describe('WHEN calling latestPrice()', () => {
        let price
        before(async () => {
          price = await adapter.latestPrice()
        })
        it('THEN the price from the dia oracle is returned', () => {
          price.toString().should.equal(ethPrice)
        })
      })
    })
    describe('AND WHEN setting a price', () => {
      let coinInfo
      before(async () => {
        oracle = await DiaOracle.new({ from: deployer })
        await oracle.updateCoinInfo(coinName, 'ETH/USD', ethPrice, '4', now)
        coinInfo = await oracle.getCoinInfo(coinName)
      })
      it('THEN the price can be read', () => {
        const price = coinInfo[0]
        const supply = coinInfo[1]
        const lastUpdateTimestamp = coinInfo[2]
        const symbol = coinInfo[3]
        price.toString().should.equal(ethPrice)
        supply.toString().should.equal('4')
        lastUpdateTimestamp.toString().should.equal(now)
        symbol.should.equal('ETH/USD')
      })
    })
  })
})
