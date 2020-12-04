// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.6.6;

interface IUSM {
    function mint(address to, uint minUsmOut) external payable returns (uint);
    function burn(address from, address payable to, uint usmToBurn, uint minEthOut) external returns (uint);
    function fund(address to, uint minFumOut) external payable returns (uint);
    function fundWithUsm(address from, address to, uint usmToBurn, uint minFumOut) external returns (uint);
    function defund(address from, address payable to, uint fumToBurn, uint minEthOut) external returns (uint);
    function defundFromFum(address from, address payable to, uint fumToBurn, uint minEthOut) external returns (uint);
}
