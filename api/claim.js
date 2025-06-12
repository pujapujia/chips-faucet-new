require("dotenv").config();
const { ethers } = require("ethers");
const fetch = require("node-fetch");

module.exports = async (req, res) => {
  console.log("API /claim called with:", req.body);

  // Check environment variables
  if (!process.env.PRIVATE_KEY || !process.env.CLAIM_TOKEN || !process.env.GITHUB_REPOSITORY) {
    console.error("Missing environment variables: PRIVATE_KEY, CLAIM_TOKEN, or GITHUB_REPOSITORY");
    return res.status(500).json({ error: "Server configuration error, contact admin" });
  }

  const GITHUB_API_URL = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/contents/claims.json`;
  const GITHUB_TOKEN = process.env.CLAIM_TOKEN;

  // Function to read claims from GitHub
  async function readClaims() {
    try {
      const response = await fetch(GITHUB_API_URL, {
        method: "GET",
        headers: {
          Authorization: `token ${GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "chips-faucet-claimer",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
      if (response.status === 404) {
        console.log("claims.json not found on GitHub, initializing empty");
        return { content: {}, sha: null };
      }
      if (!response.ok) {
        throw new Error(`Failed to read claims.json from GitHub: ${response.status} ${response.statusText}`);
      }
      const data = await response.json();
      const content = JSON.parse(Buffer.from(data.content, "base64").toString("utf8"));
      console.log("Read claims.json from GitHub:", content);
      return { content, sha: data.sha };
    } catch (error) {
      console.error("Error reading claims:", error.message);
      throw error;
    }
  }

  // Function to write claims to GitHub
  async function writeClaims(claims, sha) {
    try {
      const content = Buffer.from(JSON.stringify(claims, null, 2)).toString("base64");
      const body = {
        message: `Update claims.json for wallet ${req.body.wallet}`,
        content,
      };
      if (sha) body.sha = sha;
      const response = await fetch(GITHUB_API_URL, {
        method: "PUT",
        headers: {
          Authorization: `token ${GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "chips-faucet-claimer",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(`Failed to write claims.json to GitHub: ${response.status} ${response.statusText} - ${errorData.message}`);
      }
      console.log("Successfully wrote claims.json to GitHub");
    } catch (error) {
      console.error("Error writing claims:", error.message);
      throw error;
    }
  }

  try {
    // Check RPC connection
    const provider = new ethers.JsonRpcProvider("http://20.63.3.101:8545");
    await provider.getBlockNumber().catch((err) => {
      throw new Error(`RPC connection failed: ${err.message}`);
    });
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

    const { wallet: targetWallet } = req.body;

    // Validate input
    if (!targetWallet) {
      console.error("Missing wallet");
      return res.status(400).json({ error: "Wallet address is required" });
    }

    // Normalize wallet address
    let normalizedWallet;
    try {
      normalizedWallet = ethers.getAddress(targetWallet);
    } catch (error) {
      console.error("Invalid wallet address:", targetWallet);
      return res.status(400).json({ error: "Invalid wallet address" });
    }

    // Check 24-hour claim limit
    console.log("Checking claim for:", normalizedWallet);
    const { content: claims, sha } = await readClaims();
    const lastClaim = claims[normalizedWallet];
    const now = Date.now();
    const oneDayInMs = 24 * 60 * 60 * 1000;

    if (lastClaim && now - lastClaim < oneDayInMs) {
      const timeLeftMs = oneDayInMs - (now - lastClaim);
      const hoursLeft = Math.floor(timeLeftMs / (60 * 60 * 1000));
      const minutesLeft = Math.floor((timeLeftMs % (60 * 60 * 1000)) / (60 * 1000));
      console.log(`Wallet ${normalizedWallet} already claimed, time left: ${hoursLeft}h ${minutesLeft}m`);
      return res.status(429).json({
        error: `Wallet already claimed. Try again in ${hoursLeft} hours ${minutesLeft} minutes`,
      });
    }

    // Send 1 CHIPS
    console.log("Sending transaction to:", normalizedWallet);
    const tx = await wallet.sendTransaction({
      to: normalizedWallet,
      value: ethers.parseEther("1"),
    });
    console.log("Transaction sent, hash:", tx.hash);
    const receipt = await tx.wait();
    console.log("Transaction confirmed:", receipt.hash);

    // Save claim timestamp only if transaction succeeds
    claims[normalizedWallet] = now;
    await writeClaims(claims, sha);
    console.log("Claim saved for:", normalizedWallet);

    res.json({
      txHash: receipt.hash,
    });
  } catch (error) {
    console.error("Error claiming faucet:", error.message);
    res.status(500).json({ error: `Claim failed - ${error.message}` });
  }
};
