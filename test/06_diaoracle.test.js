const { BN, expectRevert } = require('@openzeppelin/test-helpers')
const { web3 } = require('@openzeppelin/test-helpers/src/setup')
const timeMachine = require('ganache-time-traveler')

const WadMath = artifacts.require('MockWadMath')
const DiaOracle = artifacts.require('DiaOracle')
const USMDIA = artifacts.require('USMDIA')
const FUM = artifacts.require('FUM')

require('chai').use(require('chai-as-promised')).should()

contract('USMDIA', (accounts) => {
  const [deployer, user1, user2, user3] = accounts
  const [ZERO, ONE, TWO, THREE, FOUR, EIGHT, HUNDRED, THOUSAND, WAD] = [
    0,
    1,
    2,
    3,
    4,
    8,
    100,
    1000,
    '1000000000000000000',
  ].map(function (n) {
    return new BN(n)
  })
  const WAD_MINUS_1 = WAD.sub(ONE)
  const WAD_SQUARED = WAD.mul(WAD)
  const WAD_SQUARED_MINUS_1 = WAD_SQUARED.sub(ONE)
  const sides = { BUY: 0, SELL: 1 }
  const rounds = { DOWN: 0, UP: 1 }
  const oneEth = WAD
  const oneUsm = WAD
  const oneFum = WAD
  const MINUTE = 60
  const HOUR = 60 * MINUTE
  const DAY = 24 * HOUR

  let priceWAD
  let oneDollarInEth

  function wadMul(x, y, upOrDown) {
    return x
      .mul(y)
      .add(upOrDown == rounds.DOWN ? ZERO : WAD_MINUS_1)
      .div(WAD)
  }

  function wadSquared(x, upOrDown) {
    return wadMul(x, x, upOrDown)
  }

  function wadCubed(x, upOrDown) {
    return x
      .mul(x)
      .mul(x)
      .add(upOrDown == rounds.DOWN ? ZERO : WAD_SQUARED_MINUS_1)
      .div(WAD_SQUARED)
  }

  function wadDiv(x, y) {
    return x.mul(WAD).add(y.sub(ONE)).div(y)
  }

  function wadCbrt(y, upOrDown) {
    if (y.gt(ZERO)) {
      let root, newRoot
      newRoot = y.add(TWO.mul(WAD)).div(THREE)
      const yTimesWadSquared = y.mul(WAD_SQUARED)
      do {
        root = newRoot
        newRoot = root
          .add(root)
          .add(yTimesWadSquared.div(root.mul(root)))
          .div(THREE)
      } while (newRoot.lt(root))
      if (upOrDown == rounds.UP && root.pow(THREE).lt(y.mul(WAD_SQUARED))) {
        root = root.add(ONE)
      }
      return root
    }
    return ZERO
  }

  function wadDecay(adjustment, decayFactor) {
    return WAD.add(wadMul(adjustment, decayFactor, rounds.DOWN)).sub(decayFactor)
  }

  function shouldEqual(x, y) {
    x.toString().should.equal(y.toString())
  }

  function shouldEqualApprox(x, y) {
    // Check that abs(x - y) < 0.0000001(x + y):
    const diff = x.gt(y) ? x.sub(y) : y.sub(x)
    diff.should.be.bignumber.lt(x.add(y).div(new BN(1000000)))
  }

  /* ____________________ Deployment ____________________ */

  describe('mints and burns a static amount', () => {
    let usm, fum, ethPerFund, ethPerMint, bitOfEth, snapshot, snapshotId, diaOracle
    const ticker = 'ETH/USD'
    const startPrice = '414174999000000000000'

    beforeEach(async () => {
      // Oracle params
      diaOracle = await DiaOracle.new({ from: deployer })
      await diaOracle.updateCoinInfo(ticker, ticker, startPrice, '4', Date.now().toString())

      // USMDIA
      usm = await USMDIA.new(diaOracle.address, ticker, { from: deployer })
      fum = await FUM.at(await usm.fum())
      await usm.cacheLatestPrice()

      priceWAD = await usm.latestPrice()
      oneDollarInEth = wadDiv(WAD, priceWAD, rounds.UP)

      ethPerFund = oneEth.mul(TWO) // Can be any (?) number
      ethPerMint = oneEth.mul(FOUR) // Can be any (?) number
      bitOfEth = oneEth.div(THOUSAND)

      snapshot = await timeMachine.takeSnapshot()
      snapshotId = snapshot['result']
    })

    afterEach(async () => {
      await timeMachine.revertToSnapshot(snapshotId)
    })

    describe('deployment', () => {
      it('starts with correct FUM price', async () => {
        const fumBuyPrice = await usm.fumPrice(sides.BUY)
        // The FUM price should start off equal to $1, in ETH terms = 1 / price:
        shouldEqualApprox(fumBuyPrice, oneDollarInEth)

        const fumSellPrice = await usm.fumPrice(sides.SELL)
        shouldEqualApprox(fumSellPrice, oneDollarInEth)
      })
    })

    /* ____________________ Minting and burning ____________________ */

    describe('minting and burning', () => {
      let MAX_DEBT_RATIO,
        price0,
        ethPool1,
        user1FumBalance1,
        user2FumBalance1,
        totalFumSupply1,
        buySellAdj1,
        fumBuyPrice1,
        fumSellPrice1

      beforeEach(async () => {
        MAX_DEBT_RATIO = await usm.MAX_DEBT_RATIO()
        price0 = await usm.latestPrice()
      })

      it("doesn't allow minting USMDIA before minting FUM", async () => {
        await expectRevert(usm.mint(user1, 0, { from: user2, value: ethPerMint }), 'Fund before minting')
      })

      /* ____________________ Minting FUM (aka fund()) ____________________ */

      it('allows minting FUM', async () => {
        await usm.fund(user2, 0, { from: user1, value: ethPerFund }) // fund() call #1
        await usm.fund(user2, 0, { from: user1, value: ethPerFund }) // fund() call #2 (just to make sure #1 wasn't special)

        // Uses flat FUM price until USMDIA is minted
        ethPool1 = await usm.ethPool()
        user2FumBalance1 = await fum.balanceOf(user2)
        totalFumSupply1 = await fum.totalSupply()
        buySellAdj1 = await usm.buySellAdjustment()
        fumBuyPrice1 = await usm.fumPrice(sides.BUY)
        fumSellPrice1 = await usm.fumPrice(sides.SELL)

        const targetEthPool1 = ethPerFund.mul(TWO)
        shouldEqual(ethPool1, targetEthPool1)

        // Check that the FUM created was just based on straight linear pricing - qty * price:
        const targetFumBalance1 = wadMul(ethPool1, priceWAD, rounds.DOWN)
        shouldEqualApprox(user2FumBalance1, targetFumBalance1) // Only approx b/c fumFromFund() loses some precision
        shouldEqualApprox(totalFumSupply1, targetFumBalance1)

        // And relatedly, buySellAdjustment should be unchanged (1), and FUM buy price and FUM sell price should still be $1:
        shouldEqual(buySellAdj1, WAD)
        shouldEqualApprox(fumBuyPrice1, oneDollarInEth)
        shouldEqualApprox(fumSellPrice1, oneDollarInEth)
      })

      it('sending Ether to the FUM contract mints (funds) FUM', async () => {
        await web3.eth.sendTransaction({ from: user1, to: fum.address, value: ethPerFund }) // fund() call #1
        await web3.eth.sendTransaction({ from: user1, to: fum.address, value: ethPerFund }) // fund() call #2 (just to make sure #1 wasn't special)

        // Uses flat FUM price until USMDIA is minted
        ethPool1 = await usm.ethPool()
        user1FumBalance1 = await fum.balanceOf(user1)
        totalFumSupply1 = await fum.totalSupply()
        buySellAdj1 = await usm.buySellAdjustment()
        fumBuyPrice1 = await usm.fumPrice(sides.BUY)
        fumSellPrice1 = await usm.fumPrice(sides.SELL)

        const targetEthPool1 = ethPerFund.mul(TWO)
        shouldEqual(ethPool1, targetEthPool1)

        // Check that the FUM created was just based on straight linear pricing - qty * price:
        const targetFumBalance1 = wadMul(ethPool1, priceWAD, rounds.DOWN)
        shouldEqualApprox(user1FumBalance1, targetFumBalance1) // Only approx b/c fumFromFund() loses some precision
        shouldEqualApprox(totalFumSupply1, targetFumBalance1)

        // And relatedly, buySellAdjustment should be unchanged (1), and FUM buy price and FUM sell price should still be $1:
        shouldEqual(buySellAdj1, WAD)
        shouldEqualApprox(fumBuyPrice1, oneDollarInEth)
        shouldEqualApprox(fumSellPrice1, oneDollarInEth)
      })

      describe('with existing FUM supply', () => {
        let ethPool1,
          user2FumBalance1,
          buySellAdj2,
          fumBuyPrice2,
          fumSellPrice2,
          ethPool2,
          user2UsmBalance2,
          user1UsmBalance2,
          totalUsmSupply2

        beforeEach(async () => {
          await usm.fund(user2, 0, { from: user1, value: ethPerFund })
          await usm.fund(user2, 0, { from: user1, value: ethPerFund }) // Again 2 calls, check #1 wasn't special

          ethPool1 = await usm.ethPool()
          user2FumBalance1 = await fum.balanceOf(user2)
        })

        /* ____________________ Minting USMDIA (aka mint()) ____________________ */

        it('allows minting USMDIA', async () => {
          await usm.mint(user1, 0, { from: user2, value: ethPerMint })

          // Uses flat USMDIA price first time USMDIA is minted
          ethPool2 = await usm.ethPool()
          user1UsmBalance2 = await usm.balanceOf(user1)
          totalUsmSupply2 = await usm.totalSupply()
          buySellAdj2 = await usm.buySellAdjustment()
          fumBuyPrice2 = await usm.fumPrice(sides.BUY)
          fumSellPrice2 = await usm.fumPrice(sides.SELL)

          const targetEthPool2 = ethPool1.add(ethPerMint)
          shouldEqual(ethPool2, targetEthPool2)

          // The first mint() call doesn't use sliding prices, or update buySellAdjustment, because before this call the debt
          // ratio is 0.  Only once debt ratio becomes non-zero after this call does the system start applying sliding prices.
          const targetUsmBalance2 = wadMul(ethPerMint, priceWAD, rounds.DOWN)
          shouldEqualApprox(user1UsmBalance2, targetUsmBalance2) // Only approx b/c usmFromMint() loses some precision
          shouldEqualApprox(totalUsmSupply2, targetUsmBalance2)

          shouldEqual(buySellAdj2, WAD)
          shouldEqualApprox(fumBuyPrice2, oneDollarInEth)
          shouldEqualApprox(fumSellPrice2, oneDollarInEth)
        })

        it('sending Ether to the USMDIA contract mints USMDIA', async () => {
          await web3.eth.sendTransaction({ from: user2, to: usm.address, value: ethPerMint })

          // Uses flat USMDIA price first time USMDIA is minted
          ethPool2 = await usm.ethPool()
          user2UsmBalance2 = await usm.balanceOf(user2)
          totalUsmSupply2 = await usm.totalSupply()
          buySellAdj2 = await usm.buySellAdjustment()
          fumBuyPrice2 = await usm.fumPrice(sides.BUY)
          fumSellPrice2 = await usm.fumPrice(sides.SELL)

          const targetEthPool2 = ethPool1.add(ethPerMint)
          shouldEqual(ethPool2, targetEthPool2)

          // The first mint() call doesn't use sliding prices, or update buySellAdjustment, because before this call the debt
          // ratio is 0.  Only once debt ratio becomes non-zero after this call does the system start applying sliding prices.
          const targetUsmBalance2 = wadMul(ethPerMint, priceWAD, rounds.DOWN)
          shouldEqualApprox(user2UsmBalance2, targetUsmBalance2) // Only approx b/c usmFromMint() loses some precision
          shouldEqualApprox(totalUsmSupply2, targetUsmBalance2)

          shouldEqual(buySellAdj2, WAD)
          shouldEqualApprox(fumBuyPrice2, oneDollarInEth)
          shouldEqualApprox(fumSellPrice2, oneDollarInEth)
        })

        describe('with existing USMDIA supply', () => {
          let ethPool2,
            debtRatio2,
            user1UsmBalance2,
            totalUsmSupply2,
            buySellAdj2,
            fumBuyPrice2,
            fumSellPrice2,
            usmBuyPrice2,
            usmSellPrice2

          beforeEach(async () => {
            await usm.mint(user1, 0, { from: user2, value: ethPerMint })

            ethPool2 = await usm.ethPool()
            debtRatio2 = await usm.debtRatio()
            user1UsmBalance2 = await usm.balanceOf(user1)
            totalUsmSupply2 = await usm.totalSupply()
            buySellAdj2 = await usm.buySellAdjustment()
            fumBuyPrice2 = await usm.fumPrice(sides.BUY)
            fumSellPrice2 = await usm.fumPrice(sides.SELL)
            usmBuyPrice2 = await usm.usmPrice(sides.BUY)
            usmSellPrice2 = await usm.usmPrice(sides.SELL)
          })

          it('reduces minFumBuyPrice over time', async () => {
            // Move price to get debt ratio just *above* MAX:
            const targetDebtRatio3 = MAX_DEBT_RATIO.add(WAD.div(HUNDRED)) // Eg, 80% + 1% = 81%
            const priceChangeFactor3 = wadDiv(debtRatio2, targetDebtRatio3, rounds.UP)
            const targetPrice3 = wadMul(price0, priceChangeFactor3, rounds.DOWN)
            await diaOracle.updateCoinInfo(ticker, ticker, targetPrice3, '4', Date.now().toString())
            const price3 = await usm.latestPrice()
            shouldEqual(price3, targetPrice3)

            const debtRatio3 = await usm.debtRatio()
            debtRatio3.should.be.bignumber.gt(MAX_DEBT_RATIO)

            // Calculate targetMinFumBuyPrice using the math in USMDIA._updateMinFumBuyPrice():
            const fumSupply = await fum.totalSupply()
            const targetMinFumBuyPrice4 = wadDiv(
              wadMul(WAD.sub(MAX_DEBT_RATIO), ethPool2, rounds.UP),
              fumSupply,
              rounds.UP
            )

            // Make one tiny call to fund(), just to actually trigger the internal call to _updateMinFumBuyPrice():
            await usm.fund(user3, 0, { from: user3, value: bitOfEth })

            const minFumBuyPrice4 = await usm.minFumBuyPrice()
            shouldEqualApprox(minFumBuyPrice4, targetMinFumBuyPrice4)

            // Now move forward a few days, and check that minFumBuyPrice decays by the appropriate factor:
            const block0 = await web3.eth.getBlockNumber()
            const t0 = (await web3.eth.getBlock(block0)).timestamp
            const timeDelay = 3 * DAY
            await timeMachine.advanceTimeAndBlock(timeDelay)
            const block1 = await web3.eth.getBlockNumber()
            const t1 = (await web3.eth.getBlock(block1)).timestamp
            shouldEqual(t1, t0 + timeDelay)

            const minFumBuyPrice5 = await usm.minFumBuyPrice()
            const decayFactor5 = wadDiv(ONE, EIGHT, rounds.UP)
            const targetMinFumBuyPrice5 = wadMul(minFumBuyPrice4, decayFactor5, rounds.UP)
            shouldEqual(minFumBuyPrice5, targetMinFumBuyPrice5)
          })

          /* ____________________ Minting FUM (aka fund()), now at sliding price ____________________ */

          describe('with FUM minted at sliding price', () => {
            let ethPool3,
              debtRatio3,
              user2FumBalance3,
              totalFumSupply3,
              buySellAdj3,
              fumBuyPrice3,
              fumSellPrice3,
              usmBuyPrice3,
              usmSellPrice3

            beforeEach(async () => {
              await usm.fund(user2, 0, { from: user1, value: ethPerFund })

              ethPool3 = await usm.ethPool()
              debtRatio3 = await usm.debtRatio()
              user2FumBalance3 = await fum.balanceOf(user2)
              totalFumSupply3 = await fum.totalSupply()
              buySellAdj3 = await usm.buySellAdjustment()
              fumBuyPrice3 = await usm.fumPrice(sides.BUY)
              fumSellPrice3 = await usm.fumPrice(sides.SELL)
              usmBuyPrice3 = await usm.usmPrice(sides.BUY)
              usmSellPrice3 = await usm.usmPrice(sides.SELL)
            })

            it('calculates cbrt correctly', async () => {
              const roots = [1, 2, 3, 7, 10, 99, 1001, 10000, 99999, 1000001]
              const w = await WadMath.new()
              let i, r, cube, cbrt
              for (i = 0; i < roots.length; ++i) {
                r = new BN(roots[i]).mul(WAD)
                cube = wadCubed(r, rounds.DOWN)

                cbrt = await w.wadCbrtDown(cube)
                shouldEqual(wadCbrt(cube, rounds.DOWN), cbrt)
                shouldEqual(wadCubed(cbrt, rounds.DOWN), cube)
                cbrt = await w.wadCbrtUp(cube)
                shouldEqual(wadCbrt(cube, rounds.UP), cbrt)
                shouldEqual(wadCubed(cbrt, rounds.DOWN), cube)

                cbrt = await w.wadCbrtDown(cube.add(ONE))
                shouldEqual(wadCbrt(cube.add(ONE), rounds.DOWN), cbrt)
                shouldEqual(wadCubed(cbrt, rounds.DOWN), cube)
                cbrt = await w.wadCbrtUp(cube.add(ONE))
                shouldEqual(wadCbrt(cube.add(ONE), rounds.UP), cbrt)
                shouldEqual(wadCubed(cbrt.sub(ONE), rounds.DOWN), cube)

                cbrt = await w.wadCbrtDown(cube.sub(ONE))
                shouldEqual(wadCbrt(cube.sub(ONE), rounds.DOWN), cbrt)
                shouldEqual(wadCubed(cbrt.add(ONE), rounds.DOWN), cube)
                cbrt = await w.wadCbrtUp(cube.sub(ONE))
                shouldEqual(wadCbrt(cube.sub(ONE), rounds.UP), cbrt)
                shouldEqual(wadCubed(cbrt, rounds.DOWN), cube)
              }
            })

            it('slides price correctly when minting FUM', async () => {
              const targetEthPool3 = ethPool2.add(ethPerFund)
              shouldEqual(ethPool3, targetEthPool3)

              // Check vs the integral math in USMDIA.fumFromFund():
              const targetFumOut = ethPool2.mul(ethPerFund).div(wadMul(ethPool3, fumBuyPrice2, rounds.UP))
              const targetFumBalance3 = user2FumBalance1.add(targetFumOut)
              shouldEqual(user2FumBalance3, targetFumBalance3)
              shouldEqual(totalFumSupply3, targetFumBalance3)
            })

            it('reduces debtRatio when minting FUM', async () => {
              debtRatio3.should.be.bignumber.lt(debtRatio2)
            })

            it('increases buySellAdjustment when minting FUM', async () => {
              buySellAdj3.should.be.bignumber.gt(buySellAdj2)
              // Or maybe calculate that the reduction is exactly what it should be...
            })

            it('modifies FUM mint/USMDIA burn prices as a result of minting FUM', async () => {
              // The fund() call, being a "long-ETH" operation, will make both types of long-ETH operations - fund()s and
              // burn()s - more expensive (ie, at worse prices): fund()'s fumBuyPrice should have increased (user pays a higher
              // price for further FUM), and burn()'s usmSellPrice should have decreased (user gets a lower price for their USMDIA):
              fumBuyPrice3.should.be.bignumber.gt(fumBuyPrice2)
              usmSellPrice3.should.be.bignumber.lt(usmSellPrice2)

              // Meanwhile the USMDIA *buy* price should be unchanged.  The FUM sell price will be (at least slightly) increased due
              // to fees the system collected from the fund() op above:
              shouldEqual(usmBuyPrice3, usmBuyPrice2)
              fumSellPrice3.should.be.bignumber.gt(fumSellPrice2)
            })

            it('decays buySellAdjustment over time', async () => {
              // Check that buySellAdjustment decays properly (well, approximately) over time:
              // - Start with an adjustment j != 1.
              // - Use timeMachine to move forward 180 secs = 3 min.
              // - Since USMDIA.BUY_SELL_ADJUSTMENT_HALF_LIFE = 60 (1 min), 3 min should mean a decay of ~1/8.
              // - The way our "time decay towards 1" approximation works, decaying j by ~1/8 should yield 1 + (j * 1/8) - 1/8.
              //   (See comment in USMDIA.buySellAdjustment().)

              // Need buySellAdj to be active (ie, != 1) for this test to be meaningful.  After fund() above it should be > 1:
              buySellAdj3.should.be.bignumber.gt(buySellAdj2)

              const block0 = await web3.eth.getBlockNumber()
              const t0 = (await web3.eth.getBlock(block0)).timestamp
              const timeDelay = 3 * MINUTE
              await timeMachine.advanceTimeAndBlock(timeDelay)
              const block1 = await web3.eth.getBlockNumber()
              const t1 = (await web3.eth.getBlock(block1)).timestamp
              shouldEqual(t1, t0 + timeDelay)

              const buySellAdj4 = await usm.buySellAdjustment()
              const decayFactor4 = wadDiv(ONE, EIGHT, rounds.DOWN)
              const targetBuySellAdj4 = wadDecay(buySellAdj3, decayFactor4)
              shouldEqualApprox(buySellAdj4, targetBuySellAdj4)
            })
          })

          it('allows minting USMDIA with sliding price', async () => {
            // Now for the second mint() call, which *should* create USMDIA at a sliding price, since debt ratio is no longer 0:
            await usm.mint(user1, 0, { from: user2, value: ethPerMint })
          })

          /* ____________________ Minting USMDIA (aka mint()), now at sliding price ____________________ */

          describe('with USMDIA minted at sliding price', () => {
            let ethPool3,
              debtRatio3,
              user1UsmBalance3,
              totalUsmSupply3,
              buySellAdj3,
              fumBuyPrice3,
              fumSellPrice3,
              usmBuyPrice3,
              usmSellPrice3

            beforeEach(async () => {
              await usm.mint(user1, 0, { from: user2, value: ethPerMint })

              ethPool3 = await usm.ethPool()
              debtRatio3 = await usm.debtRatio()
              user1UsmBalance3 = await usm.balanceOf(user1)
              totalUsmSupply3 = await usm.totalSupply()
              buySellAdj3 = await usm.buySellAdjustment()
              fumBuyPrice3 = await usm.fumPrice(sides.BUY)
              fumSellPrice3 = await usm.fumPrice(sides.SELL)
              usmBuyPrice3 = await usm.usmPrice(sides.BUY)
              usmSellPrice3 = await usm.usmPrice(sides.SELL)
            })

            it('slides price correctly when minting USMDIA', async () => {
              const targetEthPool3 = ethPool2.add(ethPerMint)
              shouldEqual(ethPool3, targetEthPool3)

              // Check vs the integral math in USMDIA.usmFromMint():
              const firstPart = wadCubed(wadDiv(ethPool3, ethPool2, rounds.DOWN), rounds.DOWN)
                .sub(WAD)
                .mul(ethPool2)
                .div(usmBuyPrice2)
                .add(user1UsmBalance2)
              const targetUsmBalance3 = wadCbrt(
                wadMul(firstPart, wadSquared(user1UsmBalance2, rounds.DOWN), rounds.DOWN),
                rounds.DOWN
              )
              shouldEqual(user1UsmBalance3, targetUsmBalance3)
              shouldEqual(totalUsmSupply3, targetUsmBalance3)
            })

            it('moves debtRatio towards 100% when minting USMDIA', async () => {
              if (debtRatio2.lt(WAD)) {
                debtRatio3.should.be.bignumber.gt(debtRatio2)
              } else {
                debtRatio3.should.be.bignumber.lt(debtRatio2)
              }
            })

            it('reduces buySellAdjustment when minting USMDIA', async () => {
              buySellAdj3.should.be.bignumber.lt(buySellAdj2)
            })

            it('modifies USMDIA mint/FUM burn prices as a result of minting USMDIA', async () => {
              // See parallel check after minting FUM above.
              usmBuyPrice3.should.be.bignumber.gt(usmBuyPrice2)
              fumSellPrice3.should.be.bignumber.lt(fumSellPrice2)
              shouldEqual(usmSellPrice3, usmSellPrice2)
              fumBuyPrice3.should.be.bignumber.gt(fumBuyPrice2)
            })

            it('decreases buy-sell adjustment when minting while debt ratio > 100%', async () => {
              // Move price to get debt ratio just *above* 100%:
              const targetDebtRatio4 = WAD.mul(HUNDRED.add(ONE)).div(HUNDRED) // 101%
              const priceChangeFactor4 = wadDiv(debtRatio3, targetDebtRatio4, rounds.UP)
              const targetPrice4 = wadMul(price0, priceChangeFactor4, rounds.DOWN)
              await diaOracle.updateCoinInfo(ticker, ticker, targetPrice4, '4', Date.now().toString())

              const price4 = await usm.latestPrice()
              shouldEqual(price4, targetPrice4)

              const debtRatio5 = await usm.debtRatio()
              debtRatio5.should.be.bignumber.gt(WAD)

              // And now minting should still reduce the adjustment, not increase it:
              const buySellAdj5 = await usm.buySellAdjustment()
              await usm.mint(user1, 0, { from: user2, value: bitOfEth })
              const buySellAdj6 = await usm.buySellAdjustment()
              buySellAdj6.should.be.bignumber.lt(buySellAdj5)
            })
          })

          /* ____________________ Burning FUM (aka defund()) ____________________ */

          it('allows burning FUM', async () => {
            const fumToBurn = user2FumBalance1.div(TWO) // defund 50% of the user's FUM
            await usm.defund(user2, user1, fumToBurn, 0, { from: user2 })

            const ethPool3 = await usm.ethPool()
            const user2FumBalance3 = await fum.balanceOf(user2)
            const totalFumSupply3 = await fum.totalSupply()

            const targetFumBalance3 = user2FumBalance1.sub(fumToBurn)
            shouldEqual(user2FumBalance3, targetFumBalance3)
            shouldEqual(totalFumSupply3, targetFumBalance3)

            // Check vs the integral math in USMDIA.ethFromDefund():
            const targetEthOut = ethPool2
              .mul(wadMul(fumToBurn, fumSellPrice2, rounds.DOWN))
              .div(ethPool2.add(wadMul(fumToBurn, fumSellPrice2, rounds.UP)))
            const targetEthPool3 = ethPool2.sub(targetEthOut)
            shouldEqual(ethPool3, targetEthPool3)
          })

          it('transferring FUM to the FUM contract is a defund', async () => {
            const fumToBurn = user2FumBalance1.div(TWO) // defund 50% of the user's FUM
            await fum.transfer(fum.address, fumToBurn, { from: user2 })

            const ethPool3 = await usm.ethPool()
            const user2FumBalance3 = await fum.balanceOf(user2)
            const totalFumSupply3 = await fum.totalSupply()

            const targetFumBalance3 = user2FumBalance1.sub(fumToBurn)
            shouldEqual(user2FumBalance3, targetFumBalance3)
            shouldEqual(totalFumSupply3, targetFumBalance3)

            // Check vs the integral math in USMDIA.ethFromDefund():
            const targetEthOut = ethPool2
              .mul(wadMul(fumToBurn, fumSellPrice2, rounds.DOWN))
              .div(ethPool2.add(wadMul(fumToBurn, fumSellPrice2, rounds.UP)))
            const targetEthPool3 = ethPool2.sub(targetEthOut)
            shouldEqual(ethPool3, targetEthPool3)
          })

          it('transferring FUM to the USMDIA contract is a defund', async () => {
            const fumToBurn = user2FumBalance1.div(TWO) // defund 50% of the user's FUM
            await fum.transfer(usm.address, fumToBurn, { from: user2 })

            const ethPool3 = await usm.ethPool()
            const user2FumBalance3 = await fum.balanceOf(user2)
            const totalFumSupply3 = await fum.totalSupply()

            const targetFumBalance3 = user2FumBalance1.sub(fumToBurn)
            shouldEqual(user2FumBalance3, targetFumBalance3)
            shouldEqual(totalFumSupply3, targetFumBalance3)

            // Check vs the integral math in USMDIA.ethFromDefund():
            const targetEthOut = ethPool2
              .mul(wadMul(fumToBurn, fumSellPrice2, rounds.DOWN))
              .div(ethPool2.add(wadMul(fumToBurn, fumSellPrice2, rounds.UP)))
            const targetEthPool3 = ethPool2.sub(targetEthOut)
            shouldEqual(ethPool3, targetEthPool3)
          })

          describe('with FUM burned at sliding price', () => {
            let fumToBurn, debtRatio3, buySellAdj3, fumBuyPrice3, fumSellPrice3, usmBuyPrice3, usmSellPrice3

            beforeEach(async () => {
              fumToBurn = user2FumBalance1.div(TWO)
              await usm.defund(user2, user1, fumToBurn, 0, { from: user2 })

              debtRatio3 = await usm.debtRatio()
              buySellAdj3 = await usm.buySellAdjustment()
              fumBuyPrice3 = await usm.fumPrice(sides.BUY)
              fumSellPrice3 = await usm.fumPrice(sides.SELL)
              usmBuyPrice3 = await usm.usmPrice(sides.BUY)
              usmSellPrice3 = await usm.usmPrice(sides.SELL)
            })

            it('increases debtRatio when burning FUM', async () => {
              debtRatio3.should.be.bignumber.gt(debtRatio2)
            })

            it('reduces buySellAdjustment when burning FUM', async () => {
              buySellAdj3.should.be.bignumber.lt(buySellAdj2)
            })

            it('modifies FUM burn/USMDIA mint prices as a result of burning FUM', async () => {
              // See parallel check after minting FUM above.
              fumSellPrice3.should.be.bignumber.lt(fumSellPrice2)
              usmBuyPrice3.should.be.bignumber.gt(usmBuyPrice2)
              fumBuyPrice3.should.be.bignumber.gt(fumBuyPrice2)
              shouldEqual(usmSellPrice3, usmSellPrice2)
            })
          })

          it("doesn't allow burning FUM if it would push debt ratio above MAX_DEBT_RATIO", async () => {
            // Move price to get debt ratio just *below* MAX.  Eg, if debt ratio is currently 156%, increasing the price by
            // (156% / 79%%) should bring debt ratio to just about 79%:
            const targetDebtRatio3 = MAX_DEBT_RATIO.sub(WAD.div(HUNDRED)) // Eg, 80% - 1% = 79%
            const priceChangeFactor3 = wadDiv(debtRatio2, targetDebtRatio3, rounds.DOWN)
            const targetPrice3 = wadMul(price0, priceChangeFactor3, rounds.UP)
            await diaOracle.updateCoinInfo(ticker, ticker, targetPrice3, '4', Date.now().toString())
            const price3 = await usm.latestPrice()
            shouldEqual(price3, targetPrice3)

            const debtRatio3 = await usm.debtRatio()
            debtRatio3.should.be.bignumber.lt(MAX_DEBT_RATIO)

            // Now this tiny defund() should succeed:
            await usm.defund(user2, user1, oneFum, 0, { from: user2 })

            const debtRatio4 = await usm.debtRatio()
            // Next, similarly move price to get debt ratio just *above* MAX:
            const targetDebtRatio5 = MAX_DEBT_RATIO.add(WAD.div(HUNDRED)) // Eg, 80% + 1% = 81%
            const priceChangeFactor5 = wadDiv(debtRatio4, targetDebtRatio5, rounds.UP)
            const targetPrice5 = wadMul(price3, priceChangeFactor5, rounds.DOWN)
            await diaOracle.updateCoinInfo(ticker, ticker, targetPrice5, '4', Date.now().toString())
            const price5 = await usm.latestPrice()
            shouldEqual(price5, targetPrice5)

            const debtRatio5 = await usm.debtRatio()
            debtRatio5.should.be.bignumber.gt(MAX_DEBT_RATIO)

            // And now defund() should fail:
            await expectRevert(usm.defund(user2, user1, oneFum, 0, { from: user2 }), 'Debt ratio > max')
          })

          /* ____________________ Burning USMDIA (aka burn()) ____________________ */

          it('allows burning USMDIA', async () => {
            const usmToBurn = user1UsmBalance2.div(TWO) // defund 50% of the user's USMDIA
            await usm.burn(user1, user2, usmToBurn, 0, { from: user1 })

            // Slides price correctly when burning US
            const ethPool3 = await usm.ethPool()
            const user1UsmBalance3 = await usm.balanceOf(user1)
            const totalUsmSupply3 = await usm.totalSupply()

            //console.log("user1 USMDIA: " + fl(user1UsmBalance2) + ", " + fl(user1UsmBalance3) + ", " + fl(usmToBurn))
            const targetUsmBalance3 = user1UsmBalance2.sub(usmToBurn)
            shouldEqual(user1UsmBalance3, targetUsmBalance3)
            shouldEqual(totalUsmSupply3, targetUsmBalance3)

            // Check vs the integral math in USMDIA.ethFromBurn():
            const firstPart = wadMul(
              wadMul(usmSellPrice2, totalUsmSupply2, rounds.DOWN),
              WAD.sub(wadCubed(wadDiv(totalUsmSupply3, totalUsmSupply2, rounds.UP), rounds.UP)),
              rounds.DOWN
            )
            const targetEthPool3 = wadCbrt(
              wadMul(wadSquared(ethPool2, rounds.UP), ethPool2.sub(firstPart), rounds.UP),
              rounds.UP
            )
            shouldEqual(ethPool3, targetEthPool3)
          })

          it('sending USMDIA to the USMDIA contract burns it', async () => {
            const usmToBurn = user1UsmBalance2.div(TWO) // defund 50% of the user's USMDIA
            await usm.transfer(usm.address, usmToBurn, { from: user1 })

            // Slides price correctly when burning US
            const ethPool3 = await usm.ethPool()
            const user1UsmBalance3 = await usm.balanceOf(user1)
            const totalUsmSupply3 = await usm.totalSupply()

            //console.log("user1 USMDIA: " + fl(user1UsmBalance2) + ", " + fl(user1UsmBalance3) + ", " + fl(usmToBurn))
            const targetUsmBalance3 = user1UsmBalance2.sub(usmToBurn)
            shouldEqual(user1UsmBalance3, targetUsmBalance3)
            shouldEqual(totalUsmSupply3, targetUsmBalance3)

            // Check vs the integral math in USMDIA.ethFromBurn():
            const firstPart = wadMul(
              wadMul(usmSellPrice2, totalUsmSupply2, rounds.DOWN),
              WAD.sub(wadCubed(wadDiv(totalUsmSupply3, totalUsmSupply2, rounds.UP), rounds.UP)),
              rounds.DOWN
            )
            const targetEthPool3 = wadCbrt(
              wadMul(wadSquared(ethPool2, rounds.UP), ethPool2.sub(firstPart), rounds.UP),
              rounds.UP
            )
            shouldEqual(ethPool3, targetEthPool3)
          })

          it('sending USMDIA to the FUM contract burns it', async () => {
            const usmToBurn = user1UsmBalance2.div(TWO) // defund 50% of the user's USMDIA
            await usm.transfer(fum.address, usmToBurn, { from: user1 })

            // Slides price correctly when burning US
            const ethPool3 = await usm.ethPool()
            const user1UsmBalance3 = await usm.balanceOf(user1)
            const totalUsmSupply3 = await usm.totalSupply()

            //console.log("user1 USMDIA: " + fl(user1UsmBalance2) + ", " + fl(user1UsmBalance3) + ", " + fl(usmToBurn))
            const targetUsmBalance3 = user1UsmBalance2.sub(usmToBurn)
            shouldEqual(user1UsmBalance3, targetUsmBalance3)
            shouldEqual(totalUsmSupply3, targetUsmBalance3)

            // Check vs the integral math in USMDIA.ethFromBurn():
            const firstPart = wadMul(
              wadMul(usmSellPrice2, totalUsmSupply2, rounds.DOWN),
              WAD.sub(wadCubed(wadDiv(totalUsmSupply3, totalUsmSupply2, rounds.UP), rounds.UP)),
              rounds.DOWN
            )
            const targetEthPool3 = wadCbrt(
              wadMul(wadSquared(ethPool2, rounds.UP), ethPool2.sub(firstPart), rounds.UP),
              rounds.UP
            )
            shouldEqual(ethPool3, targetEthPool3)
          })

          describe('with USMDIA burned at sliding price', () => {
            let usmToBurn, debtRatio3, buySellAdj3, fumBuyPrice3, fumSellPrice3, usmBuyPrice3, usmSellPrice3

            beforeEach(async () => {
              usmToBurn = user1UsmBalance2.div(TWO) // Burning 100% of USMDIA is an esoteric case - instead burn 50%
              await usm.burn(user1, user2, usmToBurn, 0, { from: user1 })

              debtRatio3 = await usm.debtRatio()
              buySellAdj3 = await usm.buySellAdjustment()
              fumBuyPrice3 = await usm.fumPrice(sides.BUY)
              fumSellPrice3 = await usm.fumPrice(sides.SELL)
              usmBuyPrice3 = await usm.usmPrice(sides.BUY)
              usmSellPrice3 = await usm.usmPrice(sides.SELL)
            })

            it('decreases debtRatio when burning USMDIA', async () => {
              debtRatio3.should.be.bignumber.lt(debtRatio2)
            })

            it('increases buySellAdjustment when burning USMDIA', async () => {
              buySellAdj3.should.be.bignumber.gt(buySellAdj2)
            })

            it('modifies USMDIA burn/FUM mint prices as a result of burning USMDIA', async () => {
              // See parallel check after minting FUM above.
              usmSellPrice3.should.be.bignumber.lt(usmSellPrice2)
              fumBuyPrice3.should.be.bignumber.gt(fumBuyPrice2)
              shouldEqual(usmBuyPrice3, usmBuyPrice2)
              fumSellPrice3.should.be.bignumber.gt(fumSellPrice2)
            })
          })

          it("doesn't allow burning USMDIA if debt ratio over 100%", async () => {
            // Move price to get debt ratio just *below* 100%:
            const targetDebtRatio3 = WAD.mul(HUNDRED.sub(ONE)).div(HUNDRED) // 99%
            const priceChangeFactor3 = wadDiv(debtRatio2, targetDebtRatio3, rounds.DOWN)
            const targetPrice3 = wadMul(price0, priceChangeFactor3, rounds.UP)
            await diaOracle.updateCoinInfo(ticker, ticker, targetPrice3, '4', Date.now().toString())
            const price3 = await usm.latestPrice()
            shouldEqual(price3, targetPrice3)

            const debtRatio3 = await usm.debtRatio()
            debtRatio3.should.be.bignumber.lt(WAD)

            // Now this tiny burn() should succeed:
            await usm.burn(user1, user2, oneUsm, 0, { from: user1 })

            // Next, similarly move price to get debt ratio just *above* 100%:
            const debtRatio4 = await usm.debtRatio()
            const targetDebtRatio5 = WAD.mul(HUNDRED.add(ONE)).div(HUNDRED) // 101%
            const priceChangeFactor5 = wadDiv(debtRatio4, targetDebtRatio5, rounds.UP)
            const targetPrice5 = wadMul(price3, priceChangeFactor5, rounds.DOWN)
            await diaOracle.updateCoinInfo(ticker, ticker, targetPrice5, '4', Date.now().toString())
            const price5 = await usm.latestPrice()
            shouldEqual(price5, targetPrice5)

            const debtRatio5 = await usm.debtRatio()
            debtRatio5.should.be.bignumber.gt(WAD)

            // And now the same burn() should fail:
            await expectRevert(usm.burn(user1, user2, oneUsm, 0, { from: user1 }), 'Debt ratio > 100%')
          })
        })
      })
    })
  })
})