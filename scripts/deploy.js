// 部署脚本
//   本地链：npx hardhat run scripts/deploy.js --network localhost
//   Sepolia：npx hardhat run scripts/deploy.js --network sepolia
const hre = require("hardhat");

async function main() {
  const Factory = await hre.ethers.getContractFactory("LearningCheckIn");
  const contract = await Factory.deploy();
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  const net = await hre.ethers.provider.getNetwork();

  console.log("网络：", net.name, "chainId =", net.chainId.toString());
  console.log("LearningCheckIn 已部署，合约地址：", address);
  console.log("请把该地址填入 frontend/index.html 页面的「合约地址」输入框（或使用 ?address=" + address + "）。");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
