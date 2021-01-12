// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.6.6;

import "@openzeppelin/contracts/math/SafeMath.sol";
import "./ChainlinkOracle.sol";
import "./CompoundOpenOracle.sol";
import "./OurUniswapV2TWAPOracle.sol";

contract MedianOracle is ChainlinkOracle, CompoundOpenOracle, OurUniswapV2TWAPOracle {
    using SafeMath for uint;

    constructor(
        AggregatorV3Interface chainlinkAggregator,
        UniswapAnchoredView compoundView,
        IUniswapV2Pair uniswapPair, uint uniswapToken0Decimals, uint uniswapToken1Decimals, bool uniswapTokensInReverseOrder
    ) public
        ChainlinkOracle(chainlinkAggregator)
        CompoundOpenOracle(compoundView)
        OurUniswapV2TWAPOracle(uniswapPair, uniswapToken0Decimals, uniswapToken1Decimals, uniswapTokensInReverseOrder) {}

    function latestPrice() public override(ChainlinkOracle, CompoundOpenOracle, OurUniswapV2TWAPOracle)
        view returns (uint price, uint updateTime)
    {
        (uint chainlinkPrice, uint chainlinkUpdateTime) = ChainlinkOracle.latestPrice();
        (uint compoundPrice, uint compoundUpdateTime) = CompoundOpenOracle.latestPrice();
        (uint uniswapPrice, uint uniswapUpdateTime) = OurUniswapV2TWAPOracle.latestPrice();
        uint index = medianIndex(chainlinkPrice, compoundPrice, uniswapPrice);
        if (index == 0) {
            return (chainlinkPrice, chainlinkUpdateTime);
        } else if (index == 1) {
            return (compoundPrice, compoundUpdateTime);
        } else {
            return (uniswapPrice, uniswapUpdateTime);
        }
    }

    function refreshPrice() public virtual override(Oracle, CompoundOpenOracle, OurUniswapV2TWAPOracle)
        returns (uint price, uint updateTime)
    {
        // Not ideal to call latestPrice() on one of these and refreshPrice() on two...  But it works, and inheriting them like
        // this saves significant gas:
        (uint chainlinkPrice, uint chainlinkUpdateTime) = ChainlinkOracle.latestPrice();
        (uint compoundPrice, uint compoundUpdateTime) = CompoundOpenOracle.refreshPrice();      // Note: refreshPrice()
        (uint uniswapPrice, uint uniswapUpdateTime) = OurUniswapV2TWAPOracle.refreshPrice();    // Note: refreshPrice()
        uint index = medianIndex(chainlinkPrice, compoundPrice, uniswapPrice);
        if (index == 0) {
            return (chainlinkPrice, chainlinkUpdateTime);
        } else if (index == 1) {
            return (compoundPrice, compoundUpdateTime);
        } else {
            return (uniswapPrice, uniswapUpdateTime);
        }
    }

    /**
     * @notice Currently only supports three inputs
     * @return index (0/1/2) of the median value
     */
    function medianIndex(uint a, uint b, uint c)
        private pure returns (uint index)
    {
        bool ab = a > b;
        bool bc = b > c;
        bool ca = c > a;

        index = (ca == ab ? 0 : (ab == bc ? 1 : 2));
    }
}
