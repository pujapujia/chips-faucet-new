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

  // Path untuk claims.json (cuma di root, nggak pake /tmp)
  const claimsFile = path.join(process.cwd(), "claims.json");

  // Fungsi untuk baca claims
  async function readClaims() {
    try {
      const data = await fs.readFile(claimsFile, "utf8");
      console.log("Baca claims.json:", data);
      return JSON.parse(data);
    } catch (error) {
      if (error.code === "ENOENT") {
        console.log("claims.json nggak ada, inisialisasi kosong");
        const emptyClaims = {};
        await fs.writeFile(claimsFile, JSON.stringify(emptyClaims, null, 2));
        return emptyClaims;
      }
      console.error("Gagal baca claims.json:", error.message);
      throw error;
    }
  }

  // Fungsi untuk tulis claims dan push ke GitHub
  async function writeClaims(claims) {
    try {
      // Backup claims sebelum ditulis
      let backupClaims;
      try {
        backupClaims = await fs.readFile(claimsFile, "utf8");
      } catch (error) {
        backupClaims = "{}"; // Kalau file nggak ada
      }

      // Tulis claims baru
      const data = JSON.stringify(claims, null, 2);
      await fs.writeFile(claimsFile, data);
      console.log("Tulis claims.json:", data);

      // Coba push ke GitHub
      try {
        execSync("git config --global user.email 'bot@github.com'");
        execSync("git config --global user.name 'Claims Bot'");
        execSync("git add claims.json");
        execSync(`git commit -m "Update claims.json untuk wallet ${req.body.wallet}" || true`);
        execSync(`git push https://x-access-token:${process.env.CLAIM_TOKEN}@github.com/${process.env.GITHUB_REPOSITORY}.git`);
        console.log("Berhasil push claims.json ke GitHub");
      } catch (gitError) {
        console.error("Gagal push claims.json ke GitHub:", gitError.message);
        // Rollback ke backup kalau gagal push
        await fs.writeFile(claimsFile, backupClaims);
        console.log("Rollback claims.json ke data sebelumnya");
        throw new Error("Gagal menyimpan klaim ke GitHub");
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

    // Normalisasi alamat wallet
    let normalizedWallet;
    try {
      normalizedWallet = ethers.getAddress(targetWallet);
    } catch (error) {
      console.error("Alamat wallet salah:", targetWallet);
      return res.status(400).json({ error: "Alamat wallet nggak valid" });
    }

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
