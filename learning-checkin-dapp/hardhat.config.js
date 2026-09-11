// Hardhat 配置：用于本地编译、测试与部署（可选，课堂演示也可以直接用 Remix）
require("@nomicfoundation/hardhat-toolbox");

// 若需要部署到 Sepolia，在项目根目录建一个 .env（参考 .env.example）：
//   SEPOLIA_RPC_URL=https://sepolia.infura.io/v3/你的key
//   PRIVATE_KEY=0x你的测试钱包私钥
require("dotenv").config();

const SEPOLIA_RPC_URL = process.env.SEPOLIA_RPC_URL || "";
const PRIVATE_KEY = process.env.PRIVATE_KEY || "";

module.exports = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // 部署目标链较老（不支持 Shanghai/PUSH0）时，把下面这行改成 "paris"
      evmVersion: "shanghai"
    }
  },
  networks: {
    // 本地链：npx hardhat node
    localhost: {
      url: "http://127.0.0.1:8545"
    },
    // Sepolia 测试网：需要有 RPC 与测试币
    ...(SEPOLIA_RPC_URL && PRIVATE_KEY
      ? {
          sepolia: {
            url: SEPOLIA_RPC_URL,
            accounts: [PRIVATE_KEY]
          }
        }
      : {})
  }
};
