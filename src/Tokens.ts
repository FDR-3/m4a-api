const DAI_MAINNET_TOKEN_MINT_ADDRESS = "EjmyN6qEC1Tf1JxiG1ae7UTJhUxSwk1TCWNWqxWV4J6o"
const USDC_MAINNET_TOKEN_MINT_ADDRESS = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
const SOL_MAINNET_TOKEN_MINT_ADDRESS = "So11111111111111111111111111111111111111112"
const WETH_MAINNET_TOKEN_MINT_ADDRESS = "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs"
const WBTC_MAINNET_TOKEN_MINT_ADDRESS = "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh"

export const tokenAddressStrings = 
{
  daiTokenMintAddress: DAI_MAINNET_TOKEN_MINT_ADDRESS,
  usdcTokenMintAddress: USDC_MAINNET_TOKEN_MINT_ADDRESS,
  solTokenMintAddress: SOL_MAINNET_TOKEN_MINT_ADDRESS,
  wethTokenMintAddress: WETH_MAINNET_TOKEN_MINT_ADDRESS,
  wbtcTokenMintAddress: WBTC_MAINNET_TOKEN_MINT_ADDRESS
}

export const tokenDecimalHashMap: Map<string, number> = new Map(
[
  //Key: Token Mint Address, Value: Token Decimal Amount
  [tokenAddressStrings.daiTokenMintAddress, 8],
  [tokenAddressStrings.usdcTokenMintAddress,6],
  [tokenAddressStrings.solTokenMintAddress, 9],
  [tokenAddressStrings.wethTokenMintAddress,8],
  [tokenAddressStrings.wbtcTokenMintAddress,8]
])

export const tokenMintAddressHashMap: Map<number, string> = new Map(
[
  //Key: Token ID, Value: Token Mint Address
  [1, "So11111111111111111111111111111111111111112"], //SOL
  [2, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"], //USDC
  [3, "EjmyN6qEC1Tf1JxiG1ae7UTJhUxSwk1TCWNWqxWV4J6o"], //DAI
  [4, "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs"], //WEth
  [5, "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh"] //WBtc
])