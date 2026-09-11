// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title  LearningCheckIn —— 去中心化链上学习打卡
 * @notice 课程作业示例合约。纯打卡逻辑，**不涉及任何代币、转账、资金或 NFT**
 *         （没有 payable 函数，没有任何 ETH/ERC20 交互）。
 *
 * 核心规则：
 *  1. 钱包注册：每个地址只需注册一次，注册后才能打卡。
 *  2. 每日打卡：同一个地址，每个"自然日"只能打卡一次。
 *  3. 连续打卡：昨天打过 → 连续 +1；中间漏打 → 连续天数自动清零后从今天重新计数。
 *  4. 成就解锁：连续打卡达到 7 天 / 30 天时，永久点亮对应成就标记。
 *  5. 历史查询：任何人可按键入的地址查询其历史打卡时间戳与备注。
 *
 * 关于"一天"的定义：
 *   为了让"每日一次"与北京时间一致，日切采用 **UTC+8 自然日**：
 *       dayIndex = (block.timestamp + 8 小时) / 1 天
 *   即北京时间 00:00 换日。想改成 UTC 日切，把 TZ_OFFSET 改成 0 即可。
 */
contract LearningCheckIn {
    // ============================================================
    //  常量
    // ============================================================

    /// @notice 一天的秒数
    uint256 public constant SECONDS_PER_DAY = 1 days;

    /// @notice 时区偏移（东八区）。改成 0 即为 UTC 日切。
    uint256 public constant TZ_OFFSET = 8 hours;

    /// @notice 成就阈值：连续打卡 7 天
    uint256 public constant BADGE_7 = 7;

    /// @notice 成就阈值：连续打卡 30 天
    uint256 public constant BADGE_30 = 30;

    // ============================================================
    //  数据结构
    // ============================================================

    /// @notice 用户档案（每个钱包地址一份）
    struct Profile {
        bool registered;         // 是否已完成钱包注册
        uint256 totalDays;       // 累计打卡次数（= 学习次数）
        uint256 streak;          // 当前连续打卡天数（内存值，读取时按需清零）
        uint256 maxStreak;       // 历史最长连续天数
        uint256 lastDay;         // 最近一次打卡的天序号
        uint256 firstCheckInAt;  // 首次打卡的时间戳
        bool badge7;             // 7 天连续成就标记（解锁后不可撤销）
        bool badge30;            // 30 天连续成就标记（解锁后不可撤销）
    }

    /// @notice 单次打卡记录
    struct Record {
        uint256 timestamp;       // 打卡时间戳（学习时间）
        uint256 day;             // 所属天序号
        uint256 studyMinutes;    // 本次学习时长（分钟）
        uint256 streakAt;        // 本次打卡后的连续天数
        string  note;            // 本次学习备注
    }

    // ============================================================
    //  状态变量
    // ============================================================

    /// @dev 地址 => 用户档案
    mapping(address => Profile) private _profiles;

    /// @dev 地址 => 打卡记录数组
    mapping(address => Record[]) private _records;

    /// @notice 已注册用户总数（方便前端做整体展示）
    uint256 public userCount;

    /// @notice 全站累计打卡次数
    uint256 public totalCheckIns;

    // ============================================================
    //  事件（前端可通过事件监听实时刷新）
    // ============================================================

    event Registered(address indexed user, uint256 time);
    event CheckedIn(
        address indexed user,
        uint256 day,
        uint256 studyMinutes,
        uint256 streak,
        string  note
    );
    event StreakReset(address indexed user, uint256 day);          // 漏打卡导致连续天数清零
    event BadgeUnlocked(address indexed user, uint256 threshold, uint256 time);

    // ============================================================
    //  修饰器
    // ============================================================

    /// @dev 仅允许已注册的钱包调用
    ///      注意：Solidity 普通字符串字面量只支持 ASCII，中文需要加 unicode 前缀
    modifier onlyRegistered(address user) {
        require(_profiles[user].registered, unicode"LCI: 该钱包尚未注册，请先注册");
        _;
    }

    // ============================================================
    //  内部工具函数
    // ============================================================

    /// @notice 返回当前天序号（按 UTC+8 自然日）
    function _currentDay() internal view returns (uint256) {
        return (block.timestamp + TZ_OFFSET) / SECONDS_PER_DAY;
    }

    /**
     * @dev 同步连续打卡状态：
     *      如果"最后一次打卡的天序号"不是昨天（即中间至少漏了一天），
     *      则把当前连续天数清零。这个函数在打卡前和查询时都会调用，
     *      因此漏打卡的用户无需任何操作，连续天数就会显示为 0。
     */
    function _syncStreak(address user) internal returns (bool reset) {
        Profile storage p = _profiles[user];
        // totalDays == 0 表示从未打卡，无需判断
        if (p.totalDays > 0 && p.lastDay + 1 < _currentDay()) {
            if (p.streak != 0) {
                p.streak = 0;
                reset = true;
                emit StreakReset(user, _currentDay());
            }
        }
    }

    // ============================================================
    //  写操作（需要钱包签名 / 花 Gas）
    // ============================================================

    /**
     * @notice 注册当前钱包地址（每个地址只能注册一次）
     * @dev 只写一个 bool 字段，是全网最便宜的注册方式
     */
    function register() external {
        Profile storage p = _profiles[msg.sender];
        require(!p.registered, unicode"LCI: 该钱包已经注册过了");

        p.registered = true;
        userCount += 1;

        emit Registered(msg.sender, block.timestamp);
    }

    /**
     * @notice 今日学习打卡
     * @param studyMinutes 本次学习时长（分钟），可为 0
     * @param note         本次学习备注，例如"复习第三章：状态机"
     *
     * 校验顺序：已注册 → 今天还没打过卡。两重校验同时保证了
     * "一天一次"这条规则在合约层无法被绕过。
     */
    function checkIn(uint256 studyMinutes, string calldata note)
        external
        onlyRegistered(msg.sender)
    {
        Profile storage p = _profiles[msg.sender];

        uint256 today = _currentDay();
        require(p.lastDay != today, unicode"LCI: 今天已经打过卡了，明天再来");

        // 1) 先处理断卡：漏打卡 → 连续天数清零
        _syncStreak(msg.sender);

        // 2) 连续天数 +1（首次打卡时 streak 从 0 变 1）
        p.streak += 1;

        // 3) 累计次数与最长纪录
        p.totalDays += 1;
        if (p.streak > p.maxStreak) {
            p.maxStreak = p.streak;
        }
        if (p.totalDays == 1) {
            p.firstCheckInAt = block.timestamp;
        }
        p.lastDay = today;

        // 4) 成就解锁：达到 7 天 / 30 天连续打卡
        if (!p.badge7 && p.streak >= BADGE_7) {
            p.badge7 = true;
            emit BadgeUnlocked(msg.sender, BADGE_7, block.timestamp);
        }
        if (!p.badge30 && p.streak >= BADGE_30) {
            p.badge30 = true;
            emit BadgeUnlocked(msg.sender, BADGE_30, block.timestamp);
        }

        // 5) 落库保存本次学习记录
        _records[msg.sender].push(
            Record({
                timestamp: block.timestamp,
                day: today,
                studyMinutes: studyMinutes,
                streakAt: p.streak,
                note: note
            })
        );

        totalCheckIns += 1;

        emit CheckedIn(msg.sender, today, studyMinutes, p.streak, note);
    }

    // ============================================================
    //  读操作（免费，不上链，不需要签名）
    // ============================================================

    /// @notice 当前天序号（前端可用它对账"今天"）
    function getToday() external view returns (uint256) {
        return _currentDay();
    }

    /// @notice 该地址是否已注册
    function isRegistered(address user) external view returns (bool) {
        return _profiles[user].registered;
    }

    /// @notice 该地址今天是否已打卡
    function hasCheckedInToday(address user) external view returns (bool) {
        return _profiles[user].lastDay == _currentDay() && _profiles[user].totalDays > 0;
    }

    /// @notice 该地址的打卡记录条数
    function getRecordCount(address user) external view returns (uint256) {
        return _records[user].length;
    }

    /**
     * @notice 一次性拉取前端概览所需的全部数据
     * @dev 返回值里带一个动态计算后的 streak：
     *      若已漏打卡，这里返回的就是 0（与合约内部 `_syncStreak` 的判断一致）
     */
    function getSummary(address user)
        external
        view
        returns (
            bool    registered,
            uint256 totalDays,
            uint256 streak,
            uint256 maxStreak,
            uint256 lastDay,
            uint256 firstCheckInAt,
            bool    badge7,
            bool    badge30,
            bool    checkedInToday
        )
    {
        Profile memory p = _profiles[user];
        registered = p.registered;
        totalDays = p.totalDays;
        maxStreak = p.maxStreak;
        lastDay = p.lastDay;
        firstCheckInAt = p.firstCheckInAt;
        badge7 = p.badge7;
        badge30 = p.badge30;

        uint256 today = _currentDay();
        checkedInToday = (p.totalDays > 0) && (p.lastDay == today);

        // 视图函数不能改状态，这里用内存变量模拟"断卡自动清零"
        streak = p.streak;
        if (p.totalDays > 0 && p.lastDay + 1 < today) {
            streak = 0;
        }
    }

    /// @notice 按键入的钱包地址查询历史打卡记录（时间戳 + 时长 + 备注 + 当时连续天数）
    function getRecords(address user) external view returns (Record[] memory) {
        return _records[user];
    }

    /**
     * @notice 分页查询历史记录，避免记录过多时一次拉取过大
     * @param offset 起始下标
     * @param limit  最多返回条数
     */
    function getRecordsPage(address user, uint256 offset, uint256 limit)
        external
        view
        returns (Record[] memory page, uint256 total)
    {
        Record[] storage all = _records[user];
        total = all.length;
        if (offset >= total) {
            return (new Record[](0), total);
        }
        uint256 end = offset + limit;
        if (end > total) {
            end = total;
        }
        page = new Record[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            page[i - offset] = all[i];
        }
    }

    /**
     * @notice 返回该地址所有"已打卡"的天序号数组
     * @dev 前端日历只需要把天序号换算成日期即可着色，无需逐条解析记录
     *      注意：`days` 是 Solidity 的时间单位关键字，不能用作变量名
     */
    function getCheckedDays(address user) external view returns (uint256[] memory dayList) {
        Record[] storage all = _records[user];
        dayList = new uint256[](all.length);
        for (uint256 i = 0; i < all.length; i++) {
            dayList[i] = all[i].day;
        }
    }
}
