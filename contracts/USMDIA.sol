// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.6.6;

import "./USMTemplate.sol";
import "./oracles/DiaOracleAdapter.sol";
import "./external/DiaOracle.sol";

contract USMDIA is USMTemplate, DiaOracleAdapter {
    constructor(DiaOracle oracle_, string memory ticker_) public
        USMTemplate()
        DiaOracleAdapter(oracle_, ticker_) {}
}