import * as anchor from "@coral-xyz/anchor"
import * as idl from "./LendingProtocol.json"
import { Connection, Keypair, VersionedTransaction, TransactionMessage, AddressLookupTableAccount } from "@solana/web3.js"
import { USE_JITO_BUNDLES } from "./EnvironmentSettings"

let anchorProgramInstance: anchor.Program | null = null

export function getAnchorWorkSpace(env: any): anchor.Program
{
  if(anchorProgramInstance)
    return anchorProgramInstance

  const secretKeyArray = JSON.parse(env.ORACLE_SECRET_KEY)
  const oracleKeypair = Keypair.fromSecretKey(new Uint8Array(secretKeyArray))

  //Set up connection using your env variables
  var connection: Connection
  if(USE_JITO_BUNDLES)
    //connection = new Connection("https://devnet.helius-rpc.com/?api-key=" + env.HELIUS_API_KEY, "processed")
    connection = new Connection(env.QUICK_NODE_TEST_URL, "processed")
    
  else
    //connection = new Connection("https://devnet.helius-rpc.com/?api-key=" + env.HELIUS_API_KEY, "processed")
    connection = new Connection(env.QUICK_NODE_TEST_URL, "processed")
    //connection = new Connection("http://127.0.0.1:8899", "processed")

  //browser-safe mock Wallet interface matching Anchor's expectations
  const edgeSafeWallet =
	{
    publicKey: oracleKeypair.publicKey,
    signTransaction: async (tx: any) =>
		{
      //If anchor ever tries an internal provider sign, handle it here
      if('sign' in tx)
        tx.sign([oracleKeypair])
      return tx
    },
    signAllTransactions: async (txs: any[]) =>
		{
      return txs.map(tx =>
			{
        if('sign' in tx)
					tx.sign([oracleKeypair])
        return tx
      })
    }
  }

  const provider = new anchor.AnchorProvider(connection, edgeSafeWallet, { 
  commitment: "processed",
  skipPreflight: false })

  anchorProgramInstance = new anchor.Program(idl as anchor.Idl, provider)
  
  console.log("⚡ Anchor workspace initialized and cached in V8 memory isolate!")
  return anchorProgramInstance
}

export function validateIncomingTransactions(txs: VersionedTransaction[], program: anchor.Program)
{
  const allowedInstructions = new Set(
  [
    "createNewMonthlyStatement",
    "refreshUserHealthChunkAndTokenReserves",
    "borrowTokens", 
    "withdrawTokens",
    "repayTokens",
    "liquidateAccount",
    "liquidateAccountSameToken",
    "liquidateAccountSameSubMarket"
  ])

  const actionInstructions = new Set(
  [
    "withdrawTokens", 
    "borrowTokens", 
    "repayTokens", 
    "liquidateAccount", 
    "liquidateAccountSameToken",
    "liquidateAccountSameSubMarket"
  ])

  //Intermediate array to track our program's instructions in execution order
  const sequence: { name: string, data: any, txIndex: number, ixIndex: number }[] = []

  //This is used for generating a unique temp price data account
  const transactionSignerPubKey = txs[0].message.staticAccountKeys[0]

  // --- PHASE 1: EXTRACTION & BASIC DECODING ---
  for(let i = 0; i < txs.length; i++)
  {
    const tx = txs[i]
    const compiledInstructions = tx.message.compiledInstructions
    const accountKeys = tx.message.staticAccountKeys

    for(let j = 0; j<compiledInstructions.length; j++)
    {
      const ix = compiledInstructions[j]
      const programId = accountKeys[ix.programIdIndex]

      if (programId.toBase58() === program.programId.toBase58())
      {
        try
        {
          const decoded = (program.coder.instruction as any).decode(Buffer.from(ix.data))
          
          if(!decoded)
            throw new Error("Malicious or un-parseable instruction data.")

          if(!allowedInstructions.has(decoded.name))
            throw new Error(`Forbidden method '${decoded.name}' injected into transaction payload.`)

          //RULE: 'createNewMonthlyStatement' MUST be in the very first transaction
          if(decoded.name === "createNewMonthlyStatement" && i !== 0)
            throw new Error("'createNewMonthlyStatement' must only appear in the first transaction.")

          sequence.push(
          {
            name: decoded.name,
            data: decoded.data,
            txIndex: i,
            ixIndex: j
          })
        } 
        catch (decodeError: any) 
        {
          throw new Error(`Transaction safety verification failed at Tx [${i}], Ix [${j}]: ${decodeError.message}`)
        }
      }
    }
  }

  if(sequence.length === 0)
    throw new Error("Oracle Rejected: No protocol instructions found in the transaction bundle.\nIs the Program ID correct in the IDL file?")

  // --- PHASE 2: SEQUENCE STATE & PARAMETER VALIDATION ---
  
  //Count specific instruction occurrences across the bundle
  const totalNewMonthlyStatementIx = sequence.filter(ix => ix.name === "createNewMonthlyStatement").length

  //RULE: 'createNewMonthlyStatement' can never be by itself
  if(totalNewMonthlyStatementIx === sequence.length)
    throw new Error("Oracle Rejected: 'createNewMonthlyStatement' cannot be sent by itself.")

  //Evaluate every instruction inside our ordered sequence
  for(let index = 0; index < sequence.length; index++)
  {
    const currentIx = sequence[index]

    if(currentIx.name === "refreshUserHealthChunkAndTokenReserves")
    {
      //Anchor decodes snake_case parameters into camelCase
      const closePriceAccount = currentIx.data.closePriceAccount

      //RULE: If closePriceAccount is false, a valid configuration must protect the end of the bundle
      if(!closePriceAccount)
      {
        //Grab the very last instruction in the entire sequence bundle
        const lastInstruction = sequence[sequence.length - 1]

        //Is it a valid action instruction?
        const isTerminalAction = actionInstructions.has(lastInstruction.name)

        //Or is it a clean-up refresh instruction where closePriceAccount is set to true?
        const isTerminalCleanRefresh = 
          lastInstruction.name === "refreshUserHealthChunkAndTokenReserves" && 
          lastInstruction.data.closePriceAccount === true

        //If it doesn't satisfy either allowance condition, reject the batch
        if(!isTerminalAction && !isTerminalCleanRefresh)
        {
          throw new Error
          (
            `Oracle Rejected: A 'refreshUserHealthChunkAndTokenReserves' Ix had 'closePriceAccount' set to false, ` +
            `but the final instruction in the bundle '${lastInstruction.name}' is neither a valid action ` +
            `nor a final refresh instruction with 'closePriceAccount' set to true.`
          )
        }
      }
    }
  }

  console.log("✅ Transaction Structure Verified!")

  return transactionSignerPubKey
}

export async function createVersionedTransaction(instructions: anchor.web3.TransactionInstruction[], lookUpTables: AddressLookupTableAccount[])
{
  try
  {
    if(!anchorProgramInstance || !anchorProgramInstance.provider.publicKey)
      return

    const { blockhash } = await anchorProgramInstance.provider.connection.getLatestBlockhash()

    const messageV0 = new TransactionMessage(
    {
      payerKey: anchorProgramInstance.provider.publicKey,
      recentBlockhash: blockhash,
      instructions: instructions
    }).compileToV0Message(lookUpTables)

    //Create Versioned Transaction
    const transaction = new VersionedTransaction(messageV0)

    return transaction
  }
  catch(error)
  {
    throw error
  }
}

//Robust HTTP polling confirmation helper for Serverless/Cloudflare Workers
export async function confirmTransactionPolling(
  connection: anchor.web3.Connection,
  signature: string,
  lastValidBlockHeight: number,
  commitment: anchor.web3.Commitment = "processed"
): Promise<void>
{
  const startTime = Date.now()
  
  //Map Solana's commitment levels to numerical weights for comparison
  const weights: Record<string, number> = 
  { 
    "processed": 1, 
    "confirmed": 2, 
    "finalized": 3 
  }

  const targetWeight = weights[commitment] || 1

  while(true)
  {
    //1. Check for a safety timeout (e.g., 25s) to avoid hitting Cloudflare's hard 30s limit
    if(Date.now() - startTime > 25000)
      throw new Error("Transaction confirmation timed out via polling helper.")

    //2. Fetch signature status using standard HTTP POST
    const response = await connection.getSignatureStatuses([signature])
    const status = response && response.value && response.value[0]

    if(status)
    {
      if(status.err)
        throw status.err

      const confirmationStatus = status.confirmationStatus
      const currentWeight = confirmationStatus ? (weights[confirmationStatus] || 0) : 0

      //Only accept if the current weight meets or exceeds our target weight
      if(currentWeight >= targetWeight)
        return
    }

    //3. Fallback: check block height to verify if the blockhash has expired on-chain
    const currentBlockHeight = await connection.getBlockHeight()
    if(currentBlockHeight > lastValidBlockHeight)
      throw new Error("Transaction expired. Block height exceeded lastValidBlockHeight.")

    //4. Delay 1.5 seconds between poll attempts to prevent RPC rate-limits
    await new Promise(resolve => setTimeout(resolve, 1500))
  }
}

export function parseProgramErrorCode(error: any, program: any)
{
  var errorCode = 0
  var errorMessage = ""
  var idlError = null

  if(error.InstructionError)
    if(error.InstructionError[1])
      if(error.InstructionError[1].Custom)
        errorCode = error.InstructionError[1].Custom
      else
        errorMessage = error.InstructionError[1]

  if(error.message)
  {
    errorMessage = error.message
    const errorMatch1 = error.message.match(/Error Number: (\d+)/)
    const errorMatch2 = error.message.match(/"Custom":(\d+)/)
    
    if(errorMatch1)
      if(errorMatch1[1])
        idlError = program.idl.errors.find((error: { code: number }) => error.code === parseInt(errorMatch1[1]))
    else if(errorMatch2)
      if(errorMatch2[1])
        idlError = program.idl.errors.find((error: { code: number }) => error.code === parseInt(errorMatch2[1]))
  }
  else if(errorCode)
    idlError = program.idl.errors.find((error: { code: number }) => error.code === errorCode)

  if(idlError)
    errorMessage = idlError.msg
  else if(errorMessage == "")
    errorMessage = error
  
  return errorMessage
}