const func = async function ({ deployments, getNamedAccounts }) {
  const { deploy, execute } = deployments
  const { deployer } = await getNamedAccounts()

  // TODO: check for chain id on chains that already have a dia oracle
  const ticker = 'ETH/USD'
  const diaOracle = await deploy('DiaOracle', { from: deployer })
  const price = '1200000000000000000000'
  const supply = '4'
  console.log(`Using DiaOracle on address ${diaOracle.address}`)
  await execute('DiaOracle', { from: deployer }, 'updateCoinInfo', ticker, ticker, price, supply, Date.now().toString())
  console.log(`setting initial price to ${price}`)

  const usm = await deploy('USMDIA', {
    from: deployer,
    args: [diaOracle.address, ticker],
  })
  console.log(`Deployed USMDIA to ${usm.address}`)
}

module.exports = func
module.exports.tags = ['USMDIA']
