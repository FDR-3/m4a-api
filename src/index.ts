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

import { Keypair, VersionedTransaction, TransactionMessage } from "@solana/web3.js"
import { tokenDecimalHashMap,
	tokenMintAddressHashMap,
	tokenNamesHashMap,
	tokenSellAmountsHashMap } from "./Tokens"
import BN from "bn.js"
import { getAnchorWorkSpace, validateIncomingTransactions, confirmTransactionPolling, parseProgramErrorCode } from "./AnchorWorkSpace"
import { USE_JITO_BUNDLES } from "./EnvironmentSettings"
//import { searcher, bundle } from "jito-ts"

//Define your hardcoded fiat stablecoin basket anchors
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" //6 Decimals
const USDS_MINT = "USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA" //6 Decimals
const NORMALIZER_18_DECIMALS = new BN("1000000000000000000")
const ZERO_BN = new BN(0)

enum PriceSourceIndex
{
	Jupiter = 1,
	Raydium = 2,
	Birdeye = 3
}

type priceSource =
{
	priceIndex: PriceSourceIndex,
	priceSourceName: string,
	price: BN
}

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
          //Explicitly accept any headers requested by the client (such as content-type)
          'Access-Control-Allow-Headers': request.headers.get('Access-Control-Request-Headers') || 'Content-Type, Accept',
          'Access-Control-Max-Age': '86400', //Cache preflight for 24 hours to reduce latency!
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
	const program = getAnchorWorkSpace(env)

	/*return new Response(
			JSON.stringify(
			{
				error: 'Price Oracle API is currently unavailable for maintenance'
			}),
			{
				status: 500,
				headers:
				{
					'Content-Type': 'application/json',
					'Access-Control-Allow-Origin': '*',
				},
			}
		)*/

	try
	{
		//Grab the raw binary array directly from the request strea
    const [tokenIds, hydratedTransactions] = await getTokenIdsAndSignedTransactionsFromMessageBuffer(request)

		
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
		console.log("data: ", data)

		//Get average data from Jupiter, Radium, and 
		const data2 = await getMultiSourcePrices(tokenIds, usdcTrueValue, env)
		console.log("data2: ", data2)

		/*Using api endpoint below instead of sdk since this wasn't working when deployed to cloud flare's server
		var searcherClient

		if(!USE_JITO_BUNDLES)
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

		var response: any
		const secretKeyArray = JSON.parse(env.ORACLE_SECRET_KEY)
  	const oracleKeypair = Keypair.fromSecretKey(new Uint8Array(secretKeyArray))

		const slot = new BN(await program.provider.connection.getSlot("processed"))

		const payload =
		{
			data,
			slot
		}
		
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

		const priceTransaction = new VersionedTransaction(messageV0)

		priceTransaction.sign([oracleKeypair])

		console.log("\nprice transaction size: ", priceTransaction.serialize().length)

		if(USE_JITO_BUNDLES && hydratedTransactions.length > 1)
		{
			//1. Group the oracle tx and user txs (Max 5 total transactions)
			const bundleTransactions = [priceTransaction, ...hydratedTransactions]

			if(bundleTransactions.length > 5)
				throw new Error(`Bundle transaction length was greater than 5: ${bundleTransactions.length}`)

			//2. Serialize and Base58 encode each transaction
			const encodedTransactions = new Array(bundleTransactions.length)
			for(let i=0; i<bundleTransactions.length; i++)
				encodedTransactions[i] = Buffer.from(bundleTransactions[i].serialize()).toString('base64')
    
			//3. Send via standard fetch to Jito's REST API
			console.log("Sending off Jito Bundle")
			const jitoResponse = await fetch('https://ny.testnet.block-engine.jito.wtf/api/v1/bundles',
			{
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "sendBundle",
					params:
					[
						encodedTransactions,
						{
							"encoding": "base64"
						}
					]
				})
			})

			const getBundleResponse: any = await jitoResponse.json()

			console.log(getBundleResponse.result as String)
			const jitoStatus = await fetch('https://ny.testnet.block-engine.jito.wtf/api/v1/bundles', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "getBundleStatuses",
					params: [[getBundleResponse.result as String]]
				})
			})

			const getBundleStatusesResponse = await jitoStatus.json()
			response = { getBundleResponse, getBundleStatusesResponse }

			console.log("Jito sendBundle Response:", response)
			console.log("Jito getBundleStatuses Response:", getBundleStatusesResponse)
		}
		else
		{
			console.log("Sending off Temp Price Transaction")
			
			const priceTX = await program.provider.connection.sendRawTransaction(priceTransaction.serialize(), { skipPreflight: true })
			
			const { lastValidBlockHeight } = await program.provider.connection.getLatestBlockhash()
			await confirmTransactionPolling(
        program.provider.connection,
        priceTX,
        lastValidBlockHeight,
        "processed"
      )
		
			var userTxs = []
			for(var i=0; i<hydratedTransactions.length; i++)
			{
				try 
				{
					console.log(`Sending off User Transaction(s) ${i+1} of ${hydratedTransactions.length}`)
					userTxs[i] = await program.provider.connection.sendRawTransaction(hydratedTransactions[i].serialize(), { skipPreflight: true })
					
					const { lastValidBlockHeight } = await program.provider.connection.getLatestBlockhash()
					await confirmTransactionPolling(
						program.provider.connection,
						userTxs[i],
						lastValidBlockHeight,
						"processed"
					)
					
					console.log(`Transaction submitted successfully. Signature: ${userTxs[i]}`)
				}
				catch(error: any)
				{
					throw(error)
				}
			}

			response = userTxs
		}
		
		console.log("✅ Oracle fetched prices successfully.")

		//Serialize for JSON response
		return new Response(
			JSON.stringify(
			{
				response
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
		var errorMessage = parseProgramErrorCode(error, program)
		console.error(errorMessage)

		return new Response(
			JSON.stringify(
			{
				error: errorMessage || 'Failed to generate M4A Verified Price'
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
			const sellTokenDecimals =  tokenDecimalHashMap.get(tokenId)
			if(!sellTokenDecimals)
				throw new Error(`Decimal entry not found in hash map for token: ${tokenMintAddress}`)

			//Configure a trade size that has meaningful weight (e.g., 50 tokens)
			const tokenAmountSimulatedSold = new BN(Number(tokenSellAmountsHashMap.get(tokenId)) * Math.pow(10, sellTokenDecimals))

			const quoteResponse = await fetch("https://api.jup.ag/swap/v2/order?" +
				new URLSearchParams(
				{
					inputMint: tokenMintAddress, //Non USDC Token
					outputMint: USDC_MINT, //USDC
					amount: Number(tokenAmountSimulatedSold).toString(), //simulate sell token amount
					slippageBps: "0" //Pure spot check
				}),
				{ headers: { "x-api-key": env.JUPITER_API_KEY } }
			)

			if(!quoteResponse.ok)
			{
				const errorBody = await quoteResponse.text()
				let errorMessage = errorBody
				try
				{
					const errorData: any = JSON.parse(errorBody)
					if(typeof errorData.error === "string")
						errorMessage = errorData.error
				}
				catch
				{
					//Keep the response body when it isn't JSON.
				}

				throw new Error(`Jupiter V6 quote failed for token ${tokenNamesHashMap.get(tokenId)} (${tokenMintAddress})\n${errorMessage}`)
			}

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

      if(finalPrice18Decimals.lt(ZERO_BN))
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
			if(usdcTrueValue.lt(ZERO_BN))
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

async function getMultiSourcePrices(
  tokenIds: number[],
  usdcTrueValue: BN,
  env: any
): Promise<Array<{ tokenId: number; normalizedPrice18Decimals: BN }>>
{
  const results = []
  const priceCheckedHashMap = new Map<number, boolean>()

  for(const tokenId of tokenIds)
	{
    const tokenMintAddress = tokenMintAddressHashMap.get(tokenId)

    if(!tokenMintAddress)
      throw new Error(`Requested Token Id not found in hash map for Id: ${tokenId}`)

    if(priceCheckedHashMap.get(tokenId))
      throw new Error("Duplicate Token Ids Detected")

    priceCheckedHashMap.set(tokenId, true)

    //Handle USDC
    if(tokenMintAddress === USDC_MINT)
		{
      if(usdcTrueValue.lt(ZERO_BN))
        throw new Error(`The price can't be negative: ${usdcTrueValue}`)
      
      results.push({ tokenId: tokenId, normalizedPrice18Decimals: usdcTrueValue })
      continue
    }

		console.log(`Checking source consensus for token: ${tokenNamesHashMap.get(tokenId)} (${tokenMintAddress})`)

    const sellTokenDecimals = tokenDecimalHashMap.get(tokenId)
    if(!sellTokenDecimals)
      throw new Error(`Decimal entry not found in hash map for token: ${tokenMintAddress}`)

    const tokenAmountSimulatedSold = new BN(Number(tokenSellAmountsHashMap.get(tokenId)) * Math.pow(10, sellTokenDecimals))

    //==========================================
    //FETCH FROM DIFFERENT SOURCES CONCURRENTLY
    //==========================================
    const [jupiterPrice, raydiumPrice/*, birdeyePrice*/] = await Promise.all([
      fetchJupiterPrice(tokenMintAddress, tokenId, tokenAmountSimulatedSold, usdcTrueValue, env),
			fetchRaydiumPrice(tokenMintAddress, tokenId, tokenAmountSimulatedSold, usdcTrueValue, env),
			//fetchBirdeyePrice(tokenMintAddress, tokenId, env)
      //fetchPythPrice(tokenId, env)
    ])

    const prices: priceSource[] = [
      { priceIndex: PriceSourceIndex.Jupiter, priceSourceName: "Jupiter", price: jupiterPrice },
      { priceIndex: PriceSourceIndex.Raydium, priceSourceName: "Raydium", price: raydiumPrice },
      /*{ priceIndex: PriceSourceIndex.Birdeye, priceSourceName: "Birdeye", price: birdeyePrice }*/
    ]

    //==========================================
    //STRICT DEVIATION & CONSENSUS VALIDATION
    //==========================================
    const validatedPrice = validateConsensusPrices(prices, tokenId)

    results.push({ tokenId: tokenId, normalizedPrice18Decimals: validatedPrice })

    //Format for logging
		const tokenDecimals = tokenDecimalHashMap.get(tokenId)
		if(tokenDecimals === undefined)
			throw new Error(`Decimal entry not found in hash map for ${tokenNamesHashMap.get(tokenId)} (${tokenMintAddress})`)//new BN requires tokenDecimals be defined
		const displayPrice = validatedPrice.mul(new BN(10).pow(new BN(tokenDecimals)))
    const priceStringClean = displayPrice.toString().padStart(19, '0')
    const integerPart = Number(priceStringClean.slice(0, -18)).toLocaleString('en-US')
    const decimalPart = priceStringClean.slice(-18)
    console.log(`✅ Consensus Price Approved: $${integerPart}.${decimalPart} for ${tokenNamesHashMap.get(tokenId)} (${tokenMintAddress})\n`)
  }

  return results
}

/**
* SOURCE 1: Jupiter V2/V6 Swap Quote
*/
async function fetchJupiterPrice(
  tokenMintAddress: string, 
	tokenId: number,
  tokenAmountSimulatedSold: BN,
  usdcTrueValue: BN, 
  env: any
): Promise<BN>
{
  const response = await fetch("https://api.jup.ag/swap/v2/order?" +
    new URLSearchParams({
      inputMint: tokenMintAddress,
      outputMint: USDC_MINT,
      amount: tokenAmountSimulatedSold.toString(),
      slippageBps: "0"
    }),
    { headers: { "x-api-key": env.JUPITER_API_KEY } }
  )

	if(!response.ok)
	{
		const errorBody = await response.text()
		let errorMessage = errorBody
		try
		{
			const errorData: any = JSON.parse(errorBody)
			if(typeof errorData.error === "string")
				errorMessage = errorData.error
		}
		catch
		{
			//Keep the response body when it isn't JSON.
		}

		throw new Error(`Source 1 (Jupiter) quote failed for ${tokenNamesHashMap.get(tokenId)} (${tokenMintAddress})\n${errorMessage}`)
	}

  const data: any = await response.json()
	//console.log(`\nJupiter raw data: ${JSON.stringify(data)}`)

	if(data?.outAmount === undefined || data?.outAmount === null)
		throw new Error(`Source 1 (Jupiter) quote unavailable for ${tokenNamesHashMap.get(tokenId)} (${tokenMintAddress})`)
	
  const priceImpactPct = Math.abs(parseFloat(data.priceImpactPct))
	if(!Number.isFinite(priceImpactPct))//This check prevents a NAN from passing the "if(priceImpactPct > 0.025)" check
		throw new Error(`Source 1 (Jupiter) returned invalid price impact for ${tokenNamesHashMap.get(tokenId)} (${tokenMintAddress})`)
	
  if(priceImpactPct > 0.025)
    throw new Error(`Source 1 (Jupiter) rejected: High price impact (${(priceImpactPct * 100).toFixed(2)}%)`)

  const rawOutAmount = new BN(data.outAmount)
  const usdcDecimals = new BN(1_000_000)
	const price = rawOutAmount.mul(usdcTrueValue).div(tokenAmountSimulatedSold).div(usdcDecimals)
	const tokenDecimals = tokenDecimalHashMap.get(tokenId)
	if(tokenDecimals === undefined)
		throw new Error(`Decimal entry not found in hash map for ${tokenNamesHashMap.get(tokenId)} (${tokenMintAddress})`)//new BN requires tokenDecimals be defined
	const displayPrice = price.mul(new BN(10).pow(new BN(tokenDecimals)))

	//Format for logging
	const priceStringClean = displayPrice.toString().padStart(19, '0')
	const integerPart = Number(priceStringClean.slice(0, -18)).toLocaleString('en-US')
	const decimalPart = priceStringClean.slice(-18)
	console.log(`✅ Jupiter Price: $${integerPart}.${decimalPart} for ${tokenNamesHashMap.get(tokenId)} (${tokenMintAddress})`)

  return price
}

/*
* SOURCE 2: Raydium Route API V2 Swap Quote
*/
async function fetchRaydiumPrice(
  tokenMintAddress: string,
	tokenId: number,
  tokenAmountSimulatedSold: BN,
  usdcTrueValue: BN,
  env: any
): Promise<BN>
{
  const response = await fetch("https://transaction-v1.raydium.io/compute/swap-base-in?" +
    new URLSearchParams({
      inputMint: tokenMintAddress,
      outputMint: USDC_MINT,
      amount: tokenAmountSimulatedSold.toString(),
      slippageBps: "0",
      txVersion: "V0"
    })
  )

  if(!response.ok)
		throw new Error(`Source 2 (Raydium) quote failed for ${tokenNamesHashMap.get(tokenId)} (${tokenMintAddress})`)

  const data: any = await response.json()
	//console.log(`\nRaydium raw data: ${JSON.stringify(data)}`)

	if(data?.success === false)
		throw new Error(`Source 2 (Raydium) quote failed for ${tokenNamesHashMap.get(tokenId)} (${tokenMintAddress})\n ${data.msg}`)
  if(data?.data?.outputAmount === undefined || data?.data?.outputAmount === null)
		throw new Error(`Source 2 (Raydium) quote unavailable for ${tokenNamesHashMap.get(tokenId)} (${tokenMintAddress})`)
	
  const priceImpactPct = Math.abs(parseFloat(data.data.priceImpactPct)) / 100//Has to be divided by 100 just for Raydium
  if(!Number.isFinite(priceImpactPct))//This check prevents a NAN from passing the "if(priceImpactPct > 0.025)" check
		throw new Error(`Source 2 (Raydium) returned invalid price impact for ${tokenNamesHashMap.get(tokenId)} (${tokenMintAddress})`)

  if(priceImpactPct > 0.025)
    throw new Error(`Source 2 (Raydium) rejected: High price impact (${(priceImpactPct * 100).toFixed(2)}%)`)

  const rawOutAmount = new BN(data.data.outputAmount)
  const usdcDecimals = new BN(1_000_000)
	const price = rawOutAmount.mul(usdcTrueValue).div(tokenAmountSimulatedSold).div(usdcDecimals)
	const tokenDecimals = tokenDecimalHashMap.get(tokenId)
	if(tokenDecimals === undefined)
		throw new Error(`Decimal entry not found in hash map for ${tokenNamesHashMap.get(tokenId)} (${tokenMintAddress})`)//new BN requires tokenDecimals be defined
	const displayPrice = price.mul(new BN(10).pow(new BN(tokenDecimals)))

	//Format for logging
	const priceStringClean = displayPrice.toString().padStart(19, '0')
	const integerPart = Number(priceStringClean.slice(0, -18)).toLocaleString('en-US')
	const decimalPart = priceStringClean.slice(-18)
	console.log(`✅ Raydium Price: $${integerPart}.${decimalPart} for ${tokenNamesHashMap.get(tokenId)} (${tokenMintAddress})`)

  return price
}

/*
* SOURCE 3: Birdeye Price API
*/
async function fetchBirdeyePrice(tokenMintAddress: string, tokenId: number, env: any): Promise<BN> 
{
  const response = await fetch(`https://public-api.birdeye.so/defi/price?address=${tokenMintAddress}`, {
    headers: { "X-API-KEY": env.BIRDEYE_API_KEY || "" }})

  if(!response.ok)
		throw new Error(`Source 3 (Birdeye) quote failed for ${tokenNamesHashMap.get(tokenId)} (${tokenMintAddress})`)

  const data: any = await response.json()
  const usdPrice = data?.data?.value
  if(usdPrice === undefined || usdPrice === null) 
    throw new Error(`Source 3 (Birdeye) quote not found for ${tokenNamesHashMap.get(tokenId)} (${tokenMintAddress})`)

  //Convert float price to 18-decimal BN safely
  const priceString = Number(usdPrice).toFixed(18)
  const [integerPart, fractionalPart] = priceString.split('.')
  return new BN(integerPart).mul(NORMALIZER_18_DECIMALS).add(new BN(fractionalPart))
}

/*
* SOURCE 2: Pyth Network Price Feed API
*/
/*async function fetchPythPrice(tokenId: number, env: any): Promise<BN>
{
  const pythPriceId = pythPriceIdHashMap.get(tokenId) //Map your token ID to Pyth Price ID hex
  if(!pythPriceId)
		throw new Error(`Pyth price ID missing for token ID ${tokenId}`)

  const response = await fetch(`https://hermes.pyth.network/v2/updates/price/latest?ids[]=${pythPriceId}`)
  if(!response.ok)
		throw new Error(`Source 2 (Pyth) request failed for token ID ${tokenId}`)

  const data: any = await response.json()
  const priceData = data.parsed?.[0]?.price
  if(!priceData)
		throw new Error(`Source 2 (Pyth) returned invalid structure for token ID ${tokenId}`)

  const rawPrice = new BN(priceData.price)
  const expo = Math.abs(priceData.expo)

  //Normalize Pyth price to 18 decimals
  //Pyth price = rawPrice * 10^expo. We want 18 decimals scale.
  let normalized: BN
  if(expo === 18)
    normalized = rawPrice
  else if(expo < 18)
    normalized = rawPrice.mul(new BN(10).pow(new BN(18 - expo)))
  else
    normalized = rawPrice.div(new BN(10).pow(new BN(expo - 18)))

  if(normalized.lte(ZERO_BN))
		throw new Error(`Source 2 (Pyth) returned non-positive price`)

  return normalized
}*/

/*
* Validates that all price sources agree within the maximum 1.5% allowable deviation.
* Throws an immediate error if ANY source deviates too far from the median.
*/
function validateConsensusPrices(prices: priceSource[], tokenId: number): BN
{
  //Sort prices to easily find the median
  const sorted = [...prices].sort((a, b) => (a.price.gt(b.price) ? 1 : -1))
  const median = sorted[Math.floor(sorted.length / 2)].price

  //Maximum allowed deviation: 1.5% (150 basis points out of 10,000)
  const maxDeviationBps = 150

  for(let i = 0; i < prices.length; i++)
	{
    const price = prices[i].price
    const diff = price.sub(median).abs()
    
    //Calculate deviation in basis points: (diff * 10000) / median
    const deviationBps = diff.mul(new BN(10000)).div(median)

    if(deviationBps.gt(new BN(maxDeviationBps)))
      throw new Error(`🚨 ORACLE SECURITY ALERT: ${prices[i].priceSourceName} price source for token ${tokenNamesHashMap.get(tokenId)} deviates by ${(deviationBps.toNumber() / 100).toFixed(2)}% from median, exceeding safety limit (${maxDeviationBps / 100}%). Rejecting prices`)
  }

  //Return the median price as the safe consensus price
  return median
}