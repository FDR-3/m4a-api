const USDS_MAINNET_TOKEN_MINT_ADDRESS = "USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA"
const USDC_MAINNET_TOKEN_MINT_ADDRESS = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
const SOL_MAINNET_TOKEN_MINT_ADDRESS = "So11111111111111111111111111111111111111112"
const WETH_MAINNET_TOKEN_MINT_ADDRESS = "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs"
const WBTC_MAINNET_TOKEN_MINT_ADDRESS = "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh"

const tokenIds = 
{
  usdsTokenId: 1,
  usdcTokenId: 2,
  solTokenId: 3,
  wethTokenId: 4,
  wbtcTokenId: 5
}

export const tokenAddressStrings = 
{
  usdsTokenMintAddress: USDS_MAINNET_TOKEN_MINT_ADDRESS,
  usdcTokenMintAddress: USDC_MAINNET_TOKEN_MINT_ADDRESS,
  solTokenMintAddress: SOL_MAINNET_TOKEN_MINT_ADDRESS,
  wethTokenMintAddress: WETH_MAINNET_TOKEN_MINT_ADDRESS,
  wbtcTokenMintAddress: WBTC_MAINNET_TOKEN_MINT_ADDRESS
}

export const tokenDecimalHashMap: Map<number, number> = new Map(
[
  //Key: Token Mint Address, Value: Token Decimal Amount
  [tokenIds.usdsTokenId, 6],
  [tokenIds.usdcTokenId,6],
  [tokenIds.solTokenId, 9],
  [tokenIds.wethTokenId,8],
  [tokenIds.wbtcTokenId,8]
])

export const tokenMintAddressHashMap: Map<number, string> = new Map(
[
  //Key: Token ID, Value: Token Mint Address
  [tokenIds.usdsTokenId, tokenAddressStrings.usdsTokenMintAddress], //USDS
  [tokenIds.usdcTokenId, tokenAddressStrings.usdcTokenMintAddress], //USDC
  [tokenIds.solTokenId, tokenAddressStrings.solTokenMintAddress], //SOL
  [tokenIds.wethTokenId, tokenAddressStrings.wethTokenMintAddress], //WEth
  [tokenIds.wbtcTokenId, tokenAddressStrings.wbtcTokenMintAddress] //WBtc
])

export const tokenNamesHashMap: Map<number, string> = new Map(
[
  //Key: Token ID, Value: Token Name
  [tokenIds.usdsTokenId, "USDS"], //USDS
  [tokenIds.usdcTokenId, "USDC"], //USDC
  [tokenIds.solTokenId,  "SOL"], //SOL
  [tokenIds.wethTokenId, "WEth"], //WEth
  [tokenIds.wbtcTokenId, "WBtc"] //WBtc
])

export const tokenSellAmountsHashMap: Map<number, number> = new Map(
[
  //Key: Token ID, Value: Token Simulate Sell Amount
  [tokenIds.usdsTokenId, 10000], //USDS
  //[tokenIds.usdcTokenId, 10000], //USDC get it's price from it's own function
  [tokenIds.solTokenId,  500], //SOL
  [tokenIds.wethTokenId, 50], //WEth
  [tokenIds.wbtcTokenId, 5] //WBtc
])
