import { Keypair } from "@solana/web3.js"
//import { bs58 } from "bs58" 

function generateKey() {
    console.log("--- Generating New Solana Keypair --- \n")

    // 1. Generate a new key pair
    const keypair = Keypair.generate()

    // 2. Print Public Key (Base58 encoded)
    console.log('Public Key (Address):')
    console.log(keypair.publicKey.toBase58())
    console.log('')

    // 3. Print Private Key / Secret Key as Uint8Array
    // This format is what you usually parse into JSON for environment variables
    console.log('Secret Key (Uint8Array JSON format):')
    console.log(`[${keypair.secretKey.toString()}]`)
    console.log('')

    // 4. Print Private Key as a Base58 string (Wallet Import Format)
    /*console.log('Secret Key (Base58 String):')
    console.log(bs58.encode(keypair.secretKey))
    console.log('\n--------------------------------------')*/
}

generateKey()