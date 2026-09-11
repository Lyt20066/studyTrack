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
  console.log("");
  console.log("提示：根目录的 index.html（网站版本）不接入区块链，无需填写该地址。");
  console.log("      该地址可用于 Remix 手动调用、区块链浏览器查看，");
  console.log("      或作为作业中「链上部分」的凭证。");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
