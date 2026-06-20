/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

import { Connection, PublicKey, Keypair } from "@solana/web3.js"
import { tokenDecimalHashMap, tokenMintAddressHashMap } from "./tokens"
import { sign } from 'tweetnacl'
import BN from 'bn.js'
import * as borsh from '@coral-xyz/borsh'
import { Buffer } from "node:buffer"


//Define your hardcoded fiat stablecoin basket anchors
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" //6 Decimals
const USDS_MINT = "USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA" //6 Decimals
const NORMALIZER_18_DECIMALS = new BN("1000000000000000000")
const zeroBN = new BN(0)

export default
{
	async fetch(request, env, ctx): Promise<Response>
	{
		//Enable CORS
		if(request.method === 'OPTIONS')
		{
			return new Response(null,
			{
				headers:
				{
					'Access-Control-Allow-Origin': '*',
					'Access-Control-Allow-Methods': 'POST, OPTIONS',
					'Access-Control-Allow-Headers': 'Content-Type',
				},
			})
		}

		const url = new URL(request.url)

		//Oracle update endpoint
		if(url.pathname === '/api/getM4AVerifiedPrices' && request.method === 'POST')
			return getM4AVerifiedPrices(request, env)

		return new Response('Hello World! Brah!',
		{
			headers:
			{
				'Access-Control-Allow-Origin': '*',
			},
		})
	}
} satisfies ExportedHandler<Env>

async function getM4AVerifiedPrices(request: Request, env: any): Promise<Response>
{
	try
	{
		const body = await request.json() as
		{
			tokenIds: number[]
		}

		const { tokenIds } = body

		if(tokenIds.length == 0)
			throw new Error('No Token Ids Provided To Oracle')

		/*//1. Generate a new key pair
		const keypair = Keypair.generate()
		//2. Print Public Key (Base58 encoded)
		console.log('Public Key (Address):', keypair.publicKey.toBase58())
		//3. Print Private Key / Secret Key
		//The secret key is a 64-byte Uint8Array (32 bytes private key + 32 bytes public key)
		console.log('Secret Key (Uint8Array):', keypair.secretKey)
		//4. (Optional) Print Private Key as a Base58 string
		//This format is what you usually import into wallets like Phantom
		console.log('Secret Key (Base58):', bs58.encode(keypair.secretKey))*/

		const priceCheckedHashMap = new Map<number, boolean>()//This is used to keep the server from getting tied up with a long array of the some Token Id's
		const normalizedPrices18Decimals: BN[] = []

		//1. Get USDC Value first
		const usdcTrueValue = await calculateUsdcTrueValue(env)
		console.log(`Current Calculated USDC Value: $${usdcTrueValue}`)

		//2. Query Jupiter V6 Routing Quotes for all other token values compared to USDC
    for(const tokenId of tokenIds)
		{
			const tokenMintAddress = tokenMintAddressHashMap.get(tokenId)

			if(!tokenMintAddress)
				throw new Error(`Requested Token Id not found in hash map for Id: ${tokenId}`)

			const wasPreviouslyChecked = priceCheckedHashMap.get(tokenId)

			if(wasPreviouslyChecked)
				throw new Error("Duplicate Token Ids Detected")

			priceCheckedHashMap.set(tokenId, true)

			console.log(tokenMintAddress)
			console.log("\nChecking spot price for: ", tokenMintAddress)

      if(tokenMintAddress !== USDC_MINT)
			{
				const sellTokenDecimals =  tokenDecimalHashMap.get(tokenMintAddress)
				if(!sellTokenDecimals)
					throw new Error(`Decimal entry not found in hash map for token: ${tokenMintAddress}`)

				//Configure a trade size that has meaningful weight (e.g., 50 tokens)
				const tokenAmountSimulatedSold = new BN(50)
				const inputAmount = tokenAmountSimulatedSold.mul(new BN(Math.pow(10, sellTokenDecimals))) 

				const quoteResponse = await fetch("https://api.jup.ag/swap/v2/order?" +
					new URLSearchParams(
					{
						inputMint: tokenMintAddress, //Non USDC Token
						outputMint: USDC_MINT, //USDC
						amount: Number(inputAmount).toString(), //50 full tokens
        		slippageBps: "0" //Pure spot check
					}),
					{ headers: { "x-api-key": env.JUPITER_API_KEY } }
				)

        if(!quoteResponse.ok)
          throw new Error(`Jupiter V6 quote failed for token ${tokenMintAddress}`)

        const quoteData: any = await quoteResponse.json()
				const priceImpactPct = Math.abs(parseFloat(quoteData.priceImpactPct))

				console.log(`Pool Price Impact for ${tokenAmountSimulatedSold} tokens: ${(priceImpactPct * 100).toFixed(4)}%`)
			
				//SECURITY THRESHOLD: 
				//If selling 50 tokens has more than a 2.5% price impact, reject the oracle price.
				//This stops thin-liquidity pools from being used to exploit the lending pool.
				if(priceImpactPct > 0.025)
					throw new Error(`Oracle rejected: High price impact (${(priceImpactPct * 100).toFixed(2)}%) indicates unsafe low liquidity or active manipulation.`)
        
				//2. CALCULATE THE SPOT PRICE
				const rawOutAmount = new BN(quoteData.outAmount) // Raw USDC tokens received (6 decimals)

				//We want to calculate: (rawOutAmount / inputAmount) * usdcTrueValue
				//To keep precision in integer math, we perform all multiplications BEFORE division.
				//rawOutAmount (6 decimals) * usdcTrueValue (18 decimals) = 24 decimals combined.
				//Then we divide by inputAmount (which has the sell token's native decimals).
				//This natively produces our target 18-decimal value!
				const totalValueIn18Decimals = rawOutAmount.mul(usdcTrueValue)
				const finalPrice18Decimals = totalValueIn18Decimals.div(inputAmount)

				if(finalPrice18Decimals.lt(zeroBN))
					throw new Error(`The price can't be negative: ${finalPrice18Decimals}`)

				normalizedPrices18Decimals.push(finalPrice18Decimals)

				console.log(`Derived Unit Price Normalized: ${finalPrice18Decimals}`)
      }
			else
			{
				if(usdcTrueValue.lt(zeroBN))
					throw new Error(`The price can't be negative: ${usdcTrueValue}`)

				normalizedPrices18Decimals.push(usdcTrueValue)
				console.log(`USDC value in USDS Normalized: ${usdcTrueValue}`)
			}
    }

		const secretKeyArray = JSON.parse(env.ORACLE_SECRET_KEY)
		const oracleKeypair = Keypair.fromSecretKey(new Uint8Array(secretKeyArray))
		//const rpcURL = "https://devnet.helius-rpc.com/?api-key=" + env.HELIUS_API_KEY
		const rpcURL = "https://mainnet.helius-rpc.com/?api-key=" + env.HELIUS_API_KEY
		
		const connection = new Connection("http://127.0.0.1:8899", "processed")
		const slot = new BN(await connection.getSlot("processed"))

		const payload =
		{
			tokenIds: Buffer.from(tokenIds),
			normalizedPrices18Decimals,
			slot
		}

		const signature = performED25519Signature(payload, oracleKeypair)

		console.log("Oracle fetched prices successfully.")

		//Serialize for JSON response
		return new Response(
			JSON.stringify(
			{
				m4aVerifiedPriceData: 
				{
					payload: payload,
					signature: signature
				}
			}),
			{
				status: 200,
				headers:
				{
					'Content-Type': 'application/json',
					'Access-Control-Allow-Origin': '*',
				},
			}
		)
	}
	catch(error: any)
	{
		console.error(error)

		return new Response(
			JSON.stringify(
			{
				error: error.message || 'Failed to generate M4A Verified Price'
			}),
			{
				status: 500,
				headers:
				{
					'Content-Type': 'application/json',
					'Access-Control-Allow-Origin': '*',
				},
			}
		)
	}
}

async function calculateUsdcTrueValue(env: any): Promise<BN>
{
  try
	{
    //Simulate selling 10,000 USDC to buy USDS to determine if the 1:1 peg is holding
    const testAmount = new BN(10000)
    const inputAmount = testAmount.mul(new BN(1_000_000)) //6 decimals

		const response = await fetch("https://api.jup.ag/swap/v2/order?" +
			new URLSearchParams(
			{
				inputMint: USDC_MINT, //Sell Token
				outputMint: USDS_MINT, //Buy Token
				amount: Number(inputAmount).toString(), //1 full token
				slippageBps: "0" //Pure spot check
			}),
			{ headers: { "x-api-key": env.JUPITER_API_KEY } }
		)

    if(!response.ok)
			throw new Error("Failed to check USDC peg with Jupiter Request")

    const data: any = await response.json()

    //Evaluate the price impact on the stablecoin pair
    const priceImpact = Math.abs(parseFloat(data.priceImpactPct))

		if(priceImpact > 0.025)
			throw new Error(`Price of USDC/USDS check is being impacted by more than: ${(priceImpact * 100).toFixed(2)}%`)

    const rawOutAmount = new BN(data.outAmount) // e.g. 9_995_000_000 (USDS is 6 decimals)
    const rawInputAmount = inputAmount          // 10_000_000_000

    const usdcValueIn18Decimals = rawOutAmount.mul(NORMALIZER_18_DECIMALS).div(rawInputAmount)

    //Check for a 1% depeg deviation
    //1% of 10^18 is 10^16
    const deviationLimit = new BN(10).pow(new BN(16))
    const currentDeviation = usdcValueIn18Decimals.sub(NORMALIZER_18_DECIMALS).abs()

    if(currentDeviation.gte(deviationLimit))
		{
      console.error(`🚨 ALERT: SIGNIFICANT STABLECOIN DEPEG DETECTED! USDC/USDS 18-dec cross-rate: ${usdcValueIn18Decimals.toString()}`)
      return usdcValueIn18Decimals // Returns degraded true value (e.g., 0.985000000000000000)
    }

    return NORMALIZER_18_DECIMALS // Returns exactly 1.000000000000000000
  }
	catch(err: any)
	{
    throw err
  }
}

function performED25519Signature(
  payload: { tokenIds: Buffer; normalizedPrices18Decimals: BN[]; slot: BN }, 
  oracleKeypair: Keypair): number[]
{
  
  //1. Define Borsh layout matching your Rust struct: PriceDataPayload
  const layout = borsh.struct([
    borsh.vecU8("tokenIds"),
    borsh.vec(borsh.u128(), "normalizedPrices18Decimals"),
    borsh.u64("slot"),
  ])

  //2. Dynamically allocate buffer size based on payload data lengths
  const buffer = Buffer.alloc(layout.span + payload.tokenIds.length + (payload.normalizedPrices18Decimals.length * 16) + 20)
  const length = layout.encode(payload, buffer)
  
  //3. Trim the buffer to exactly match the serialized payload size
  const messageBuffer = buffer.subarray(0, length)

  //4. Generate the Ed25519 Signature
  const signatureBytes = sign.detached(messageBuffer, oracleKeypair.secretKey)

  return Array.from(signatureBytes)
}