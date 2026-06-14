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
import { tokenDecimalHashMap } from "./tokens"
import { sign } from 'tweetnacl'

//Define your hardcoded fiat stablecoin basket anchors
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" //6 Decimals
const USDS_MINT = "USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA" //6 Decimals

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
		if(url.pathname === '/api/getM4AVerifiedPrice' && request.method === 'POST')
			return getM4AVerifiedPrice(request, env)

		return new Response('Hello World! Brah!',
		{
			headers:
			{
				'Access-Control-Allow-Origin': '*',
			},
		})
	}
} satisfies ExportedHandler<Env>

async function getM4AVerifiedPrice(request: Request, env: any): Promise<Response>
{
	try
	{
		const body = await request.json() as
		{
			tokenMintAddressArray: string[]
		}

		const { tokenMintAddressArray } = body
		console.log(tokenMintAddressArray)

		if(tokenMintAddressArray.length == 0)
			throw new Error('No Token Mint Addresses Provided To Oracle')

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

		//const rpcURL = "https://devnet.helius-rpc.com/?api-key=" + env.HELIUS_API_KEY
		const rpcURL = "https://mainnet.helius-rpc.com/?api-key=" + env.HELIUS_API_KEY
		const connection = new Connection(rpcURL, "processed")
		const slot = await connection.getSlot("processed")
		const slotFinalized = await connection.getSlot("finalized")
		console.log("Actual processed Slot: ", slot)
		console.log("Actual finalized Slot: ", slotFinalized)

    const secretKeyArray = JSON.parse(env.ORACLE_SECRET_KEY)
    const oracleKeypair = Keypair.fromSecretKey(new Uint8Array(secretKeyArray))

		const m4aVerifiedPrices: any[] = []

		//1. Get USDC Value first
		const usdcTrueValue = await calculateUsdcTrueValue(env)
		console.log(`Current Calculated USDC Value: $${usdcTrueValue}`)

		//2. Query Jupiter V6 Routing Quotes for all other token values compared to USDC
    for(const tokenMintAddress of tokenMintAddressArray)
		{
			console.log("\nChecking spot price for: ", tokenMintAddress)
			var normalizedPrice8Decimals = 0

      if(tokenMintAddress !== USDC_MINT)
			{
				const sellTokenDecimals =  tokenDecimalHashMap.get(tokenMintAddress)
				if(!sellTokenDecimals)
					throw new Error(`Decimal entry not found in hash map for token: ${tokenMintAddress}`)

				//Configure a trade size that has meaningful weight (e.g., 50 tokens)
				const tokenAmountSimulatedSold = 50
				const inputAmount = tokenAmountSimulatedSold * Math.pow(10, sellTokenDecimals)

				const quoteResponse = await fetch("https://api.jup.ag/swap/v2/order?" +
					new URLSearchParams(
					{
						inputMint: tokenMintAddress, //Non USDC Token
						outputMint: USDC_MINT, //USDC
						amount: inputAmount.toString(), //50 full tokens
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
				const rawOutAmount = Number(quoteData.outAmount) //Raw usdc simulated received amount
				const usdcReceived = rawOutAmount / 1_000_000 //Adjusted for USDC's 6 decimals

				//Divide the total USDC received by the number of tokens we simulated selling
				const rawPriceInUsdc = usdcReceived / tokenAmountSimulatedSold 

				//FIX: Multiply the raw AMM exchange rate by the real-world value of a single USDC unit!
				//If USDC = $1.00, price remains identical. If USDC = $0.80, the price scales down correctly.
				const priceInUsdc = rawPriceInUsdc * usdcTrueValue

				//3. Normalize price to 8 decimals for lending protocol
				normalizedPrice8Decimals = Math.round(priceInUsdc * 100_000_000)
				
				console.log(`Derived Unit Price: $${priceInUsdc} | Normalized: ${normalizedPrice8Decimals}`)
      }
			else
			{
				normalizedPrice8Decimals = Math.round(usdcTrueValue * 100_000_000)
				console.log(`USDC value in USDS: ${usdcTrueValue} | Normalized: ${normalizedPrice8Decimals}`)
			}

			if(normalizedPrice8Decimals < 0)
				throw new Error(`The price can't be negative: ${normalizedPrice8Decimals}`)
			
      //1. Allocate a flat 48-byte buffer space
			//32 bytes (TokenMintAddress) + 8 bytes (Price) + 8 bytes (Slot) = 48 bytes
			const messageBuffer = new Uint8Array(48)

			//2. Extract the raw 32-byte array from the Solana Public Key string
			const tokenMintPublicKey = new PublicKey(tokenMintAddress)
			const tokenMintBytes = tokenMintPublicKey.toBytes() //Uint8Array of length 32

			//3. Write the 32-byte mint directly into the front of our buffer (Bytes 0 to 31)
			messageBuffer.set(tokenMintBytes, 0)

			//4. Use a DataView to write the remaining 64-bit numbers right after the mint bytes
			//We point the DataView specifically at the memory buffer
			const view = new DataView(messageBuffer.buffer)

			//Bytes 32-39: Price (Offsets by 32 bytes)
			view.setBigUint64(32, BigInt(normalizedPrice8Decimals), true)

			//Bytes 40-47: Slot (Offsets by 40 bytes)
			view.setBigUint64(40, BigInt(slot), true)

      //5. Generate Ed25519 signature
			//Oracle signs message as valid
      const signatureBytes = sign.detached(messageBuffer, oracleKeypair.secretKey)

      m4aVerifiedPrices.push(
			{
        tokenMint: tokenMintAddress,
        price: normalizedPrice8Decimals,
        slot: slot,
        signature: Buffer.from(signatureBytes).toString('hex')
      })
    }

		console.log("Oracle fetched prices successfully.")

		//Serialize for JSON response
		return new Response(
			JSON.stringify(
			{
				m4aVerifiedPrices: m4aVerifiedPrices
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

async function calculateUsdcTrueValue(env: any): Promise<number>
{
  try
	{
    //Simulate selling 10,000 USDC to buy USDS to determine if the 1:1 peg is holding
    const testAmount = 10000
    const inputAmount = testAmount * 1_000_000 //6 decimals

		const response = await fetch("https://api.jup.ag/swap/v2/order?" +
			new URLSearchParams(
			{
				inputMint: USDC_MINT, //Sell Token
				outputMint: USDS_MINT, //Buy Token
				amount: inputAmount.toString(), //1 full token
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

    const outAmount = Number(data.outAmount) / 1_000_000 //6 decimals

    //Under normal conditions, 10k USDC yields ~10k USDS (Value close to 1.00)
    const usdcValueInUsds = outAmount / testAmount

    //SECURITY BRAKE: If the cross-rate deviates significantly without high organic price impact,
    //a real depeg event or severe stable-pool drain is occurring.
    if(Math.abs(1.0 - usdcValueInUsds) >= 0.01)
		{
      console.error(`🚨 ALERT: SIGNIFICANT STABLECOIN DEPEG DETECTED! USDC/USDS cross-rate: ${usdcValueInUsds}`)
      //Return the adjusted cross-rate value to safely scale down your oracle calculations
      return usdcValueInUsds
    }

    return 1.0 //Peg is safely holding inside normal boundaries
  }
	catch(err: any)
	{
    throw err
  }
}