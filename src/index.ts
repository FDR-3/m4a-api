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

import { Keypair, VersionedTransaction, TransactionMessage, Transaction } from "@solana/web3.js"
import { tokenDecimalHashMap,
	tokenMintAddressHashMap,
	tokenNamesHashMap,
	tokenSellAmountsHashMap } from "./Tokens"
import BN from "bn.js"
import { getAnchorWorkSpace, validateIncomingTransactions } from "./AnchorWorkSpace"
import { LOCAL_MODE } from "./EnvironmentSettings"
import { searcher, bundle } from "jito-ts"
import bs58 from "bs58"

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
		if(url.pathname === '/Api/bundleProtocolPriceTransactions' && request.method === 'POST')
			return bundleProtocolPriceTransactions(request, env)

		return new Response('Hello World! Brah!',
		{
			headers:
			{
				'Access-Control-Allow-Origin': '*',
			},
		})
	}
} satisfies ExportedHandler<Env>

async function bundleProtocolPriceTransactions(request: Request, env: any): Promise<Response>
{
	try
	{
		//Grab the raw binary array directly from the request strea
    const [tokenIds, hydratedTransactions] = await getTokenIdsAndSignedTransactionsFromMessageBuffer(request)

		const program = getAnchorWorkSpace(env)
		const transactionSignerPubKey = validateIncomingTransactions(hydratedTransactions, program)
		console.log("transactionSignerPubKey: ", transactionSignerPubKey.toBase58())
		
		//Get USDC Value first
		const usdcTrueValue = await calculateUsdcTrueValue(env)
		//Pad string out to 19 characters to guarantee the slice logic functions cleanly below $1.00
		const priceStringClean = usdcTrueValue.toString().padStart(19, '0')
		const integerPart = priceStringClean.toString().slice(0, -18)
		const formatedIntegerPart = Number(integerPart).toLocaleString('en-US')
		const decimalPart = priceStringClean.toString().slice(-18)
		console.log(`Current Calculated USDC Value: $${formatedIntegerPart}.${decimalPart}`)

		//Query Jupiter V6 Routing Quotes for all other token values compared to USDC
		const data = await getUSDCPrices(tokenIds, usdcTrueValue, env)

		/*Using api endpoint below instead of sdk since this wasn't working when deployed to cloud flare's server
		var searcherClient

		if(!LOCAL_MODE)
		{
			//Create the searcher client that will interact with Jito
			searcherClient = searcher.searcherClient("ny.testnet.block-engine.jito.wtf")
			//Subscribe to the bundle result
			searcherClient.onBundleResult(
				(result) => {
				console.log("received bundle result:", result)
			},
			(e) => {
				throw e
			}
		)*/

		const slot = new BN(await program.provider.connection.getSlot("processed"))

		const payload =
		{
			data,
			slot
		}
		const secretKeyArray = JSON.parse(env.ORACLE_SECRET_KEY)
  	const oracleKeypair = Keypair.fromSecretKey(new Uint8Array(secretKeyArray))

		const createTempOraclePriceDataInstruction = await program.methods.createTempOraclePriceData(payload)
      .accounts({ lendingUserAddress: transactionSignerPubKey })
			.instruction()

    const latestBlockhash = await program.provider.connection.getLatestBlockhash()

		const messageV0 = new TransactionMessage(
		{
			payerKey: oracleKeypair.publicKey,
			recentBlockhash: latestBlockhash.blockhash,
			instructions: [createTempOraclePriceDataInstruction]
		}).compileToV0Message()

		const tx = new VersionedTransaction(messageV0)

		tx.sign([oracleKeypair])

		console.log("\nprice transaction size: ", tx.serialize().length)

		var resp

		if(!LOCAL_MODE)
		{
			//1. Group the oracle tx and user txs (Max 5 total transactions)
			const bundleTransactions = [tx, ...hydratedTransactions]

			//2. Serialize and Base58 encode each transaction
			const encodedTransactions = bundleTransactions.map(t => bs58.encode(t.serialize()))

			//3. Send via standard fetch to Jito's REST API
			const jitoResponse = await fetch('https://ny.testnet.block-engine.jito.wtf/api/v1/bundles', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "sendBundle",
					params: [
						encodedTransactions
					]
				})
			})

			resp = await jitoResponse.json()

			console.log(resp.result as String)
			const jitoStatus = await fetch('https://ny.testnet.block-engine.jito.wtf/api/v1/bundles', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "getBundleStatuses",
					params: [
						resp.result as String
					]
				})
			})

			const resp2 = await jitoStatus.json()

			console.log("Jito REST Bundle Response:", resp)
			console.log("Jito REST Bundle Response:", resp2)
		}
		else
		{
			const priceTransaction = new Transaction
			priceTransaction.add(createTempOraclePriceDataInstruction)

			priceTransaction.recentBlockhash = latestBlockhash.blockhash
			priceTransaction.feePayer = oracleKeypair.publicKey

			//Oracle Signs the price data transaction
			priceTransaction.sign(oracleKeypair)

			await program.provider.connection.sendRawTransaction(priceTransaction.serialize(), { skipPreflight: false })

			await timeOutFunction(0.4)
		
			var userTxs = []
			for(var i=0; i<hydratedTransactions.length; i++)
			{
				try 
				{
					userTxs[i] = await program.provider.connection.sendRawTransaction(hydratedTransactions[i].serialize(), { skipPreflight: false })
					await timeOutFunction(0.4)
					console.log(`Transaction submitted successfully. Signature: ${userTxs[i]}`)
				}
				catch(error: any)
				{
					throw(error)
				}
			}

			resp = userTxs
		}
		
		console.log("Oracle fetched prices successfully.")

		//Serialize for JSON response
		return new Response(
			JSON.stringify(
			{
				resp
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

async function getTokenIdsAndSignedTransactionsFromMessageBuffer(request: Request): Promise<[number[], VersionedTransaction[]]>
{
	const arrayBuffer = await request.arrayBuffer()
	const view = new DataView(arrayBuffer)
	const fullUint8Array = new Uint8Array(arrayBuffer)
	const tokenIds: number[] = []
	const hydratedTransactions: VersionedTransaction[] = []
	console.log("SERVER: Incoming request content-length header =", request.headers.get("content-length"))
	console.log("SERVER: Received arrayBuffer byteLength =", arrayBuffer.byteLength)

	let offset = 0

	//Unpack Token IDs
	const tokenIdsLength = view.getUint32(offset, true)
	offset += 4
	
	for(let i = 0; i<tokenIdsLength; i++)
	{
		tokenIds.push(view.getUint8(offset))
		offset += 1
	}

	if(tokenIds.length === 0)
		throw new Error('No Token Ids Provided To Oracle')

	//Unpack and Hydrate Transactions
	const txsLength = view.getUint32(offset, true)
	offset += 4

	for (let i = 0; i<txsLength; i++)
	{
		const txSize = view.getUint32(offset, true)
		offset += 4

		//Extract the exact slice belonging to this transaction
		const txBytes = fullUint8Array.subarray(offset, offset + txSize)
		offset += txSize

		hydratedTransactions.push(VersionedTransaction.deserialize(txBytes))
	}

	return [tokenIds, hydratedTransactions]
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

async function getUSDCPrices(tokenIds: number[], usdcTrueValue: BN, env: any)
{
	var data = []
	const priceCheckedHashMap = new Map<number, boolean>()//This is used to keep the server from getting tied up with a long array of the same Token Id's
	const normalizedPrices18Decimals: BN[] = []
	//Query Jupiter V6 Routing Quotes for all other token values compared to USDC
	for(const tokenId of tokenIds)
	{
		const tokenMintAddress = tokenMintAddressHashMap.get(tokenId)

		if(!tokenMintAddress)
			throw new Error(`Requested Token Id not found in hash map for Id: ${tokenId}`)

		const wasPreviouslyChecked = priceCheckedHashMap.get(tokenId)

		if(wasPreviouslyChecked)
			throw new Error("Duplicate Token Ids Detected")

		priceCheckedHashMap.set(tokenId, true)

		console.log("\ntokenMintAddress: ", tokenMintAddress)
		console.log("Checking spot price for: ", tokenNamesHashMap.get(tokenId))

		if(tokenMintAddress !== USDC_MINT)
		{
			const sellTokenDecimals =  tokenDecimalHashMap.get(tokenMintAddress)
			if(!sellTokenDecimals)
				throw new Error(`Decimal entry not found in hash map for token: ${tokenMintAddress}`)

			//Configure a trade size that has meaningful weight (e.g., 50 tokens)
			const tokenAmountSimulatedSold = new BN(Number(tokenSellAmountsHashMap.get(tokenId)))
			const inputAmount = tokenAmountSimulatedSold.mul(new BN(Math.pow(10, sellTokenDecimals))) 

			const quoteResponse = await fetch("https://api.jup.ag/swap/v2/order?" +
				new URLSearchParams(
				{
					inputMint: tokenMintAddress, //Non USDC Token
					outputMint: USDC_MINT, //USDC
					amount: Number(inputAmount).toString(), //simulate sell token amount
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
			//If selling tokenAmountSimulatedSold amount has more than a 2.5% price impact, reject the oracle price.
			//This stops thin-liquidity pools from being used to exploit the lending pool.
			if(priceImpactPct > 0.025)
				throw new Error(`Oracle rejected: High price impact (${(priceImpactPct * 100).toFixed(2)}%) indicates unsafe low liquidity or active manipulation.`)
			
			//2. CALCULATE THE SPOT PRICE
			const rawOutAmount = new BN(quoteData.outAmount) //Raw USDC tokens received (6 decimals)

			const usdcDecimals = new BN(1_000_000) // USDC's 6 decimal fractional scale

      //The Native Decimals are irrelevant here because Jupiter already gave us the USDC 
      //value for EXACTLY tokenAmountSimulatedSold amount. 
      //1. rawOutAmount (6 dec) * usdcTrueValue (18 dec) = 24 decimals of scale
      //2. Divide by tokensSold (50) = USD value of exactly 1 token (still 24 decimals)
      //3. Divide by usdcDecimals (1,000,000) to drop 6 zeroes and perfectly land at 18 decimals!
      const finalPrice18Decimals = rawOutAmount.mul(usdcTrueValue).div(tokenAmountSimulatedSold).div(usdcDecimals)

      if(finalPrice18Decimals.lt(zeroBN))
        throw new Error(`The price can't be negative: ${finalPrice18Decimals}`)

			data.push({ tokenId: tokenId, normalizedPrice18Decimals: finalPrice18Decimals })

      //Pad string out to 19 characters to guarantee the slice logic functions cleanly below $1.00
      const priceStringClean = finalPrice18Decimals.toString().padStart(19, '0')
      const integerPart = priceStringClean.slice(0, -18)
			const formatedIntegerPart = Number(integerPart).toLocaleString('en-US')
      const decimalPart = priceStringClean.slice(-18)
      console.log(`Price Normalized: $${formatedIntegerPart}.${decimalPart}`)
		}
		else
		{
			if(usdcTrueValue.lt(zeroBN))
				throw new Error(`The price can't be negative: ${usdcTrueValue}`)

			data.push({ tokenId: tokenId, normalizedPrice18Decimals: usdcTrueValue })

			//Pad string out to 19 characters to guarantee the slice logic functions cleanly below $1.00
      const priceStringClean = usdcTrueValue.toString().padStart(19, '0')
      const integerPart = priceStringClean.slice(0, -18)
			const formatedIntegerPart = Number(integerPart).toLocaleString('en-US')
      const decimalPart = priceStringClean.slice(-18)
      console.log(`Price Normalized: $${formatedIntegerPart}.${decimalPart}`)
		}
	}
		
	return data
}

/*function performED25519Signature(
  payload: { tokenIds: Buffer, normalizedPrices18Decimals: BN[], slot: BN }, 
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
}*/

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function timeOutFunction(timeToWaitInSeconds: number)
{
	timeOutCountDown(timeToWaitInSeconds)

	const timeToWaitInMilliSeconds = timeToWaitInSeconds * 1000
	console.log("\nSleeping for: " + timeToWaitInSeconds + " seconds")
	await sleep(timeToWaitInMilliSeconds)
}

function timeOutCountDown(timeToWaitInSeconds: number)
{
	var timeLeftInSeconds = timeToWaitInSeconds
	console.log(`\n${timeLeftInSeconds} Timeout Seconds Left`)

	const countDownIntervalId = setInterval(() =>
	{
		timeLeftInSeconds -= 10
		if(timeLeftInSeconds > 0)
			console.log(`${timeLeftInSeconds} Timeout Seconds Left`)
		
		if(timeLeftInSeconds <= 0)
			clearInterval(countDownIntervalId)  
	}, 10000) 
}