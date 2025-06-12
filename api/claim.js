require("dotenv").config();
const { ethers } = require("ethers");
const fs = require("fs").promises;
const path = require("path");
const { execSync } = require("child_process");

module.exports = async (req, res) => {
  console.log("API /claim dipanggil dengan:", req.body);

  // Cek environment variables
  if (!process.env.PRIVATE_KEY || !process.env.CLAIM_TOKEN || !process.env.GITHUB_REPOSITORY) {
    console.error("Environment variables hilang: PRIVATE_KEY, CLAIM_TOKEN, atau GITHUB_REPOSITORY");
    return res.status(500).json({ error: "Konfigurasi server salah" });
  }

  // Path untuk claims.json
  const tmpClaimsFile = path.join("/tmp", "claims.json");
  const rootClaimsFile = path.join(process.cwd(), "claims.json");

  // Fungsi untuk baca claims
  async function readClaims() {
    try {
      let data;
      try {
        // Coba baca dari /tmp
        data = await fs.readFile(tmpClaimsFile, "utf8");
        console.log("Baca /tmp/claims.json:", data);
      } catch (error) {
        if (error.code === "ENOENT") {
          console.log("/tmp/claims.json nggak ada, coba root claims.json");
          try {
            // Coba baca dari root
            data = await fs.readFile(rootClaimsFile, "utf8");
            console.log("Baca root claims.json:", data);
            await fs.writeFile(tmpClaimsFile, data); // Sinkronkan ke /tmp
          } catch (rootError) {
            console.log("Nggak ada root claims.json, inisialisasi kosong");
            data = "{}";
            await fs.writeFile(tmpClaimsFile, data);
          }
        } else {
          throw error;
        }
      }
      return JSON.parse(data);
    } catch (error) {
      console.error("Gagal baca claims:", error.message);
      throw error;
    }
  }

  // Fungsi untuk tulis claims dan push ke GitHub
  async function writeClaims(claims) {
    try {
      const data = JSON.stringify(claims, null, 2);
      // Tulis ke /tmp
      await fs.writeFile(tmpClaimsFile, data);
      console.log("Tulis /tmp/claims.json:", data);

      // Coba push ke GitHub
      try {
        // Setup git
        execSync("git config --global user.email 'bot@github.com'");
        execSync("git config --global user.name 'Claims Bot'");
        // Copy ke root untuk commit
        await fs.copyFile(tmpClaimsFile, rootClaimsFile);
        // Commit dan push
        execSync("git add claims.json");
        execSync(`git commit -m "Update claims.json untuk wallet ${req.body.wallet}" || true`);
        execSync(`git push https://x-access-token:${process.env.CLAIM_TOKEN}@github.com/${process.env.GITHUB_REPOSITORY}.git`);
        console.log("Berhasil push claims.json ke GitHub");
      } catch (gitError) {
        console.error("Gagal push claims.json ke GitHub:", gitError.message);
        // Nggak throw error, biar transaksi tetep sukses
      }
    } catch (error) {
      console.error("Gagal tulis claims:", error.message);
      throw error;
    }
  }

  try {
    // Cek koneksi RPC
    const provider = new ethers.JsonRpcProvider("http://20.63.3.101:8545");
    await provider.getBlockNumber().catch((err) => {
      throw new Error(`Koneksi RPC gagal: ${err.message}`);
    });
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

    const { wallet: targetWallet } = req.body;

    // Validasi input
    if (!targetWallet) {
      console.error("Wallet nggak ada");
      return res.status(400).json({ error: "Alamat wallet wajib diisi" });
    }

    // Validasi alamat wallet
    if (!ethers.isAddress(targetWallet)) {
      console.error("Alamat wallet salah:", targetWallet);
      return res.status(400).json({ error: "Alamat wallet nggak valid" });
    }

    // Normalisasi alamat wallet (biar case-insensitive)
    const normalizedWallet = ethers.getAddress(targetWallet);

    // Cek batas klaim 24 jam
    console.log("Cek klaim untuk:", normalizedWallet);
    const claims = await readClaims();
    const lastClaim = claims[normalizedWallet];
    const now = Date.now();
    const oneDayInMs = 24 * 60 * 60 * 1000;

    if (lastClaim && now - lastClaim < oneDayInMs) {
      const timeLeftMs = oneDayInMs - (now - lastClaim);
      const hoursLeft = Math.floor(timeLeftMs / (60 * 60 * 1000));
      const minutesLeft = Math.floor((timeLeftMs % (60 * 60 * 1000)) / (60 * 1000));
      console.log(`Wallet ${normalizedWallet} udah klaim, sisa waktu: ${hoursLeft}j ${minutesLeft}m`);
      return res.status(429).json({
        error: `Wallet udah klaim. Coba lagi dalam ${hoursLeft} jam ${minutesLeft} menit`,
      });
    }

    // Kirim 1 CHIPS
    console.log("Kirim transaksi ke:", normalizedWallet);
    const tx = await wallet.sendTransaction({
      to: normalizedWallet,
      value: ethers.parseEther("1"),
    });
    console.log("Transaksi terkirim, hash:", tx.hash);
    const receipt = await tx.wait();
    console.log("Transaksi dikonfirmasi:", receipt.hash);

    // Simpan timestamp klaim hanya kalau transaksi sukses
    claims[normalizedWallet] = now;
    await writeClaims(claims);
    console.log("Klaim disimpan untuk:", normalizedWallet);

    res.json({
      txHash: receipt.hash,
    });
  } catch (error) {
    console.error("Gagal klaim faucet:", error.message);
    res.status(500).json({ error: `Klaim gagal - ${error.message}` });
  }
};
