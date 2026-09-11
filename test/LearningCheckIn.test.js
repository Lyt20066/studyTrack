// 合约单元测试：npx hardhat test
// 覆盖注册、一天一次、连续天数、漏打卡清零、成就解锁、历史记录查询
const { expect } = require("chai");
const { ethers, network } = require("hardhat");

const DAY = 86400;

describe("LearningCheckIn 学习打卡合约", function () {
  let contract, owner, alice;

  beforeEach(async function () {
    [owner, alice] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("LearningCheckIn");
    contract = await Factory.deploy();
    await contract.waitForDeployment();
  });

  /** 本地链时间快进 n 天（模拟跨天、漏打卡） */
  const nextDay = async (count = 1) => {
    await network.provider.send("evm_increaseTime", [DAY * count]);
    await network.provider.send("evm_mine");
  };

  it("注册：未注册不能打卡，且每个地址只能注册一次", async function () {
    expect(await contract.isRegistered(owner.address)).to.equal(false);
    await expect(contract.checkIn(30, "未注册先打卡"))
      .to.be.revertedWith("LCI: 该钱包尚未注册，请先注册");

    await contract.register();
    expect(await contract.isRegistered(owner.address)).to.equal(true);
    expect(await contract.userCount()).to.equal(1n);

    await expect(contract.register())
      .to.be.revertedWith("LCI: 该钱包已经注册过了");
  });

  it("打卡：正确记录学习时长、备注、次数与连续天数", async function () {
    await contract.register();
    await contract.checkIn(45, "第一天的学习：Solidity 基础");

    const s = await contract.getSummary(owner.address);
    expect(s[0]).to.equal(true);  // registered
    expect(s[1]).to.equal(1n);    // totalDays
    expect(s[2]).to.equal(1n);    // streak
    expect(s[3]).to.equal(1n);    // maxStreak
    expect(s[8]).to.equal(true);  // checkedInToday

    const recs = await contract.getRecords(owner.address);
    expect(recs.length).to.equal(1);
    expect(recs[0].studyMinutes).to.equal(45n);
    expect(recs[0].note).to.equal("第一天的学习：Solidity 基础");
    expect(recs[0].timestamp).to.be.greaterThan(0n);
  });

  it("限制：同一天只能打卡一次", async function () {
    await contract.register();
    await contract.checkIn(30, "第一次");
    await expect(contract.checkIn(30, "第二次"))
      .to.be.revertedWith("LCI: 今天已经打过卡了，明天再来");
  });

  it("连续打卡递增；漏打卡后连续天数自动清零", async function () {
    await contract.register();
    await contract.checkIn(30, "第 1 天");
    await nextDay();
    await contract.checkIn(30, "第 2 天");

    let s = await contract.getSummary(owner.address);
    expect(s[2]).to.equal(2n);   // 连续 2 天
    expect(s[3]).to.equal(2n);   // 历史最长 2 天

    // 跳过 3 天不打卡 → 连续天数清零
    await nextDay(3);
    s = await contract.getSummary(owner.address);
    expect(s[2]).to.equal(0n);   // 断卡自动清零
    expect(s[1]).to.equal(2n);   // 累计次数不受影响
    expect(s[8]).to.equal(false);

    // 重新打卡 → 连续天数从 1 重新开始
    await contract.checkIn(30, "断卡后重新开始");
    s = await contract.getSummary(owner.address);
    expect(s[2]).to.equal(1n);
    expect(s[1]).to.equal(3n);
    expect(s[3]).to.equal(2n);   // 历史最长连续仍然保留
  });

  it("成就：连续 7 天解锁标记，解锁后不会因断卡丢失", async function () {
    await contract.register();
    await contract.checkIn(30, "第 1 天");
    for (let i = 0; i < 6; i++) {
      await nextDay();
      await contract.checkIn(30, `第 ${i + 2} 天`);
    }

    let s = await contract.getSummary(owner.address);
    expect(s[2]).to.equal(7n);
    expect(s[6]).to.equal(true);   // 7 天成就已解锁
    expect(s[7]).to.equal(false);  // 30 天成就未解锁

    await nextDay(10);             // 断卡
    s = await contract.getSummary(owner.address);
    expect(s[2]).to.equal(0n);     // 连续清零
    expect(s[6]).to.equal(true);   // 成就依然保留
  });

  it("查询：按地址读取历史记录、已打卡天序号，多用户数据互不影响", async function () {
    await contract.register();
    await contract.checkIn(20, "第 1 天");
    await nextDay();
    await contract.checkIn(30, "第 2 天");
    await nextDay();
    await contract.checkIn(40, "第 3 天");

    const recs = await contract.getRecords(owner.address);
    expect(recs.length).to.equal(3);
    expect(recs[2].streakAt).to.equal(3n);
    expect(await contract.getRecordCount(owner.address)).to.equal(3n);

    const days = await contract.getCheckedDays(owner.address);
    expect(days.length).to.equal(3);
    expect(days[1]).to.equal(days[0] + 1n);   // 天序号连续
    expect(days[2]).to.equal(days[1] + 1n);

    const [page, total] = await contract.getRecordsPage(owner.address, 1, 1);
    expect(total).to.equal(3n);
    expect(page.length).to.equal(1);

    // 另一个地址的数据是独立的
    const otherSum = await contract.getSummary(alice.address);
    expect(otherSum[0]).to.equal(false);
    expect(otherSum[1]).to.equal(0n);
  });
});
