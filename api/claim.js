require("dotenv").config();
const { ethers } = require("ethers");
const fetch = require("node-fetch");

module.exports = async (req, res) => {
  console.log("API /claim dipanggil dengan:", req.body);

  // Cek environment variables
  if (!process.env.PRIVATE_KEY || !process.env.CLAIM_TOKEN || !process.env.GITHUB_REPOSITORY) {
    console.error("Environment variables hilang: PRIVATE_KEY, CLAIM_TOKEN, atau GITHUB_REPOSITORY");
    return res.status(500).json({ error: "Konfigurasi server salah, hubungi admin" });
  }

  const GITHUB_API_URL = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/contents/claims.json`;
  const GITHUB_TOKEN = process.env.CLAIM_TOKEN;

  // Fungsi untuk baca claims dari GitHub
  async function readClaims() {
    try {
      const response = await fetch(GITHUB_API_URL, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "chips-faucet-claimer",
        },
      });
      if (response.status === 404) {
        console.log("claims.json nggak ada di GitHub, inisialisasi kosong");
        return { content: {}, sha: null };
      }
      if (!response.ok) {
        throw new Error(`Gagal baca claims.json dari GitHub: ${response.status} ${response.statusText}`);
      }
      const data = await response.json();
      const content = JSON.parse(Buffer.from(data.content, "base64").toString("utf8"));
      console.log("Baca claims.json dari GitHub:", content);
      return { content, sha: data.sha };
    } catch (error) {
      console.error("Gagal baca claims:", error.message);
      throw error;
    }
  }

  // Fungsi untuk tulis claims ke GitHub
  async function writeClaims(claims, sha) {
    try {
      const content = Buffer.from(JSON.stringify(claims, null, 2)).toString("base64");
      const body = {
        message: `Update claims.json untuk wallet ${req.body.wallet}`,
        content,
      };
      if (sha) body.sha = sha; // Sertakan sha kalau file sudah ada
      const response = await fetch(GITHUB_API_URL, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "chips-faucet-claimer",
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        throw new Error(`Gagal tulis claims.json ke GitHub: ${response.status} ${response.statusText}`);
      }
      console.log("Berhasil tulis claims.json ke GitHub");
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
    const { content: claims, sha } = await readClaims();
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
    await writeClaims(claims, sha);
    console.log("Klaim disimpan untuk:", normalizedWallet);

    res.json({
      txHash: receipt.hash,
    });
  } catch (error) {
    console.error("Gagal klaim faucet:", error.message);
    res.status(500).json({ error: `Klaim gagal - ${error.message}` });
  }
};
