// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.6.6;

import '../external/DiaOracle.sol';
import './Oracle.sol';

/**
 * @title DiaOracleAdapter
 */
contract DiaOracleAdapter is Oracle {
    DiaOracle public immutable oracle;
    string public ticker;

    constructor(DiaOracle oracle_, string memory ticker_) public
    {
        oracle = oracle_;
        ticker = ticker_;
    }

    /**
     * @notice Retrieve the latest price of the price oracle.
     * @return price
     */
    function latestPrice() public virtual override view returns (uint price) {
        price = getDiaPrice();
    }

    /**
     * @notice Retrieve the latest price of the price oracle.
     * @return price
     */
    function getDiaPrice() private view returns(uint price) {
      (price,,,) = oracle.getCoinInfo(ticker);
    }
}
