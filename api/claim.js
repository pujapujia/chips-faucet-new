require("dotenv").config();
const { ethers } = require("ethers");
const fs = require("fs").promises;
const path = require("path");
const { execSync } = require("child_process");

module.exports = async (req, res) => {
  console.log("API /claim called with:", req.body);

  // Cek environment variables
  if (!process.env.PRIVATE_KEY) {
    console.error("Missing PRIVATE_KEY");
    return res.status(500).json({ error: "Missing PRIVATE_KEY" });
  }

  // Path untuk claims.json di /tmp
  const claimsFile = path.join("/tmp", "claims.json");

  // Fungsi untuk baca claims
  async function readClaims() {
    try {
      const data = await fs.readFile(claimsFile, "utf8");
      console.log("Read claims.json:", data);
      return JSON.parse(data);
    } catch (error) {
      if (error.code === "ENOENT") {
        console.log("claims.json not found, initializing empty claims");
        await fs.writeFile(claimsFile, "{}");
        return {};
      }
      console.error("Error reading claims:", error.message);
      throw error;
    }
  }

  // Fungsi untuk tulis claims dan push ke GitHub
  async function writeClaims(claims) {
    try {
      const data = JSON.stringify(claims, null, 2);
      await fs.writeFile(claimsFile, data);
      console.log("Wrote claims.json:", data);
      if (process.env.CLAIM_TOKEN) {
        try {
          // Setup git
          execSync("git config --global user.email 'bot@github.com'");
          execSync("git config --global user.name 'Claims Bot'");
          // Copy claims.json ke root untuk commit
          await fs.copyFile(claimsFile, path.join(process.cwd(), "claims.json"));
          // Commit dan push
          execSync("git add claims.json");
          execSync(`git commit -m "Update claims.json for wallet ${req.body.wallet}"`);
          execSync(`git push https://x-access-token:${process.env.CLAIM_TOKEN}@github.com/${process.env.GITHUB_REPOSITORY}.git`);
          console.log("Pushed claims.json to GitHub");
        } catch (error) {
          console.error("Failed to push claims.json:", error.message);
        }
      }
    } catch (error) {
      console.error("Failed to write claims:", error.message);
      throw error;
    }
  }

  try {
    // Cek koneksi RPC
    const provider = new ethers.JsonRpcProvider("http://20.63.3.101:8545");
    await provider.getBlockNumber().catch((err) => {
      throw new Error(`RPC connection failed: ${err.message}`);
    });
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

    const { wallet: targetWallet } = req.body;

    // Validasi input
    if (!targetWallet) {
      console.error("Missing wallet");
      return res.status(400).json({ error: "Missing wallet address" });
    }

    // Validasi alamat wallet
    if (!ethers.isAddress(targetWallet)) {
      console.error("Invalid wallet address:", targetWallet);
      return res.status(400).json({ error: "Invalid wallet address" });
    }

    // Cek batas klaim 24 jam
    console.log("Checking claim for:", targetWallet);
    const claims = await readClaims();
    const lastClaim = claims[targetWallet];
    const now = Date.now();
    const oneDayInMs = 24 * 60 * 60 * 1000;

    if (lastClaim && now - lastClaim < oneDayInMs) {
      const timeLeftMs = oneDayInMs - (now - lastClaim);
      const hoursLeft = Math.floor(timeLeftMs / (60 * 60 * 1000));
      const minutesLeft = Math.floor((timeLeftMs % (60 * 60 * 1000)) / (60 * 1000));
      console.log(`Wallet ${targetWallet} claimed, time left: ${hoursLeft}h ${minutesLeft}m`);
      return res.status(429).json({
        error: `Wallet already claimed. Try again in ${hoursLeft} hours ${minutesLeft} minutes`,
      });
    }

    // Kirim 1 CHIPS
    console.log("Sending transaction to:", targetWallet);
    const tx = await wallet.sendTransaction({
      to: targetWallet,
      value: ethers.parseEther("1"),
    });
    console.log("Transaction sent, hash:", tx.hash);
    const receipt = await tx.wait();
    console.log("Transaction confirmed:", receipt.hash);

    // Simpan timestamp klaim
    claims[targetWallet] = now;
    await writeClaims(claims);
    console.log("Claim saved for:", targetWallet);

    res.json({
      txHash: receipt.hash,
    });
  } catch (error) {
    console.error("Error claiming faucet:", error.message);
    res.status(500).json({ error: `Claim failed - ${error.message}` });
  }
};
