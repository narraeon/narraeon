import type { ContentTreeFile } from "../../protocol/v1.ts";
import { storyControlFiles } from "./story-controls.ts";

export const missingReelChinese: readonly ContentTreeFile[] = [
  {
    path: "opening.md",
    contents: `潮屋声音档案馆的墙上挂着一张旧照片。四十个码头工人挤作一排，张大嘴，想把歌声唱过雾笛。要是一切顺利，晚上六点，他们的声音会在这间屋子里第一次响起。距录音那天，整整三十年。

玻璃展柜敞着。蓝毡上留了个盘子大的圆印，里头一点灰也没有。

“五点二十还在这儿。”档案员许玛说。她往旁边让了一步。去年冬天你帮馆里编过目录，她记得你有个习惯：就算不信一个人的话，也会把对方的原话记下来。

门口的志愿者罗安拿着一只灰帆布套。“我本来要拿这个装母带。我能告诉你谁签了到。”

音响师桑薇把一张黄色工单对折，字折在里面。她身后，一口黑色器材箱咔哒一声合上了。“试音文件还能放。我们可以照常开门。”

玻璃门外，第一位客人试了试门把手，有点不好意思地举了举纸请柬。许玛把展柜钥匙放在蓝毡上，恰好挨着那个空圆印。

“你愿意帮我弄清楚刚才到底发生了什么吗？”
`,
  },
  {
    path: "world/current-situation.yaml",
    contents: `$document:
  id: situation.missing-reel
  ref: current-situation
  title: 蓝毡上的圆印
  summary: 公开试听会开始前不到半小时，展出的母带不见了。
  aliases: []
背景:
  时间: 周六下午五点三十二分
  地点: 潮屋声音档案馆展厅
在场:
  - { $ref: character.mara-vale }
  - { $ref: character.noel-park }
  - { $ref: character.viv-santos }
  - { $ref: character.player }
待回应:
  说话人: { $ref: character.mara-vale }
  原话: 你愿意帮我弄清楚刚才到底发生了什么吗？
  位置: 许玛刚把展柜钥匙搁在母带留下的空圆印旁。
眼前的事:
  - 罗安拿着灰帆布套，愿意交代哪些人签了到。
  - 桑薇提议播放试音文件，照常开门。
  - 第一位来宾在上锁的公用入口外。即使玩家把调查留给许玛，也可以帮忙接待。
`,
  },
  {
    path: "world/characters/player.yaml",
    contents: `$document:
  id: character.player
  ref: protagonist
  title: 玩家主角
  summary: 玩家扮演曾在潮屋声音档案馆整理录音目录的志愿者。
  aliases: []
与此地的关系: 去年冬天来帮录音编目。许玛信任玩家会分清谁说了什么、哪些可以核实。
权限: 今天以客人身份到场。可以请许玛协助保存物证或进入馆内区域。无权命令他人或翻查私人物品。
`,
  },
  {
    path: "world/characters/mara.yaml",
    contents: `$document:
  id: character.mara-vale
  ref: mara
  title: 许玛
  summary: 负责保管母带的档案员，也是试听会的组织者。
  aliases: []
动机: 想让歌者和家属听到完整录音。要是有具体理由可以向门外的家属交代，她会推迟试听。
行事: 一紧张就把时间和日期说得很准。问到钥匙或手续，她会直接回答。
认知:
  亲眼所见: 五点二十检查过母带的黄铜轴芯。为预定的试音把展柜留在虚掩状态。
  判断: 觉得可能有人布置时顺手挪走了母带。她没完整听过试音文件。
  权限: 展柜上锁后要用她的钥匙。试音布置期间没有锁死，不用钥匙也能掀盖。
`,
  },
  {
    path: "world/characters/noel.yaml",
    contents: `$document:
  id: character.noel-park
  ref: noel
  title: 罗安
  summary: 掌管来宾签到表和母带收纳套的门口志愿者。
  aliases: []
动机: 想争取一份有薪档案实习，怕许玛把自己没登记的一次跑腿当作失职。
行事: 先说签到表。问他亲眼见到了什么，他能说出走廊见闻，也会承认自己帮忙开门却没登记。
认知:
  亲眼所见: 约五点二十八分，他从茶水台拿纸杯回来，替桑薇扶了一下工作走廊的门。她双手平端一只浅浅的灰色校准箱。
  判断: 当时以为箱里是试音用的配重盘。手中的灰帆布套刚从储物柜取来，今天没装过母带。
  边界: 许玛检查以后，他没再留意展柜。签到表只记来宾，不记馆员走动。
`,
  },
  {
    path: "world/characters/viv.yaml",
    contents: `$document:
  id: character.viv-santos
  ref: viv
  title: 桑薇
  summary: 负责试听和设备领用的音响师。
  aliases: []
动机: 外婆桑黛唱了第一段，还在母带的开头念出码头工人各自的名字。桑薇想在捐赠方带走拷贝之前补回这些署名。
行事: 在人前办事利落，无凭无据指责她会激起防备。若先核实缺失的报幕再私下谈，她可能主动开箱。
认知:
  所做的事: 母带是她移进校准箱的，她知道确切位置。
  依据: 发现短版试音文件剪掉了外婆的报幕。手里拿着自己填的设备工单黄联。
  猜测: 以为许玛知情并签批了捐赠方的剪辑版。她没看过许玛真正签字的那一张。
`,
  },
  {
    path: "world/locations/exhibition-room.yaml",
    contents: `$document:
  id: location.tidehouse-exhibition
  ref: exhibition-room
  title: 潮屋展厅
  summary: 陈设展柜和试听设备的地方，隔板后通往工作走廊。
  aliases: []
出入: 公共大门预定六点开启，许玛可以改时间。馆员和许玛陪同的来客可进工作走廊。
展柜: 柜盖带铰链，蓝毡衬底，虚掩时可掀开。毡上的空圆印就是母带原位。沿后铰链侧着打光，可以看见夹住的一根亮橙色棉线。
试听台: 公用耳机可以播放试音文件。展台旁的印刷曲目单把第一轨标为念名报幕加第一段歌。实际试听从第二段歌开始。
平日: 展厅也办开放试听和社区访谈录音。
`,
  },
  {
    path: "world/locations/service-corridor.yaml",
    contents: `$document:
  id: location.tidehouse-corridor
  ref: service-corridor
  title: 工作走廊
  summary: 这里有设备领用架、装卸门，也是音响师准备器材的地方。
  aliases: []
设备: C 格里有一只合上的浅灰色校准箱，吊牌上系着橙色棉绳，绳头刚散开。目击者能把它和展厅里那个又高又黑的器材箱分辨开。
记录: 领用板留白色原单，每张单据都有编号。041 号上有桑薇的签名，五点二十六领用灰色校准箱。旁边的清单写着原本装在箱里的配重盘今天一早就借出去了。许玛可以带玩家来核查。
时限: 五点五十有承包商来收闲置设备。在箱子运走前提醒许玛，她可以叫停收运。
平日: 工作人员在这里登记外借设备、张贴维修和收运通知。
`,
  },
  {
    path: "world/locations/reading-room.yaml",
    contents: `$document:
  id: location.tidehouse-reading-room
  ref: reading-room
  title: 潮屋阅览室
  summary: 公用阅览桌旁保管曲目单、审批文件和录音署名。
  aliases: []
出入: 试听会开放期间可自由查阅活动文件的桌面副本，开门前可请许玛带路。
记录: 原曲目单上，报幕人写着桑黛。许玛签批播放带完整口述署名的长版录音。另一张捐赠方的打样单把短版写成“最终版”，却没有馆方签字。
平日: 来访者可以听数字化录音、帮忙听写姓名，或约一次自己的录音访谈。
`,
  },
  {
    path: "world/case/public-notes.yaml",
    contents: `$document:
  id: case.missing-reel-notes
  ref: case-notes
  title: 调查笔记
  summary: 记录已经让玩家知道的观察和证言。
  aliases: []
已知线索:
  空展柜: 许玛说五点二十见过母带。玩家亲眼看见蓝毡上的空圆印。
`,
  },
  {
    path: "world/case/custody.yaml",
    contents: `$document:
  id: case.reel-custody
  ref: reel-custody
  title: 母带保管记录
  summary: 供主持者核对母带去向和移动过程。
  aliases: []
物件: 唯一完整原件的黄铜轴芯刻着 TS-017。数字试音文件是另一个短版。
开场时的位置: 工作走廊 C 格的灰色校准箱内，装在干净纸套里。原件完好。
已发生的事:
  - 五点二十，许玛在展柜看见母带，为试音把柜盖留作虚掩。
  - 五点二十六，桑薇领用空的灰色校准箱。五点二十七，她从展柜取走母带，装入箱中，箱上吊牌的棉绳被展柜铰链夹落一根线。五点二十八，罗安替她扶门，她把箱子放回 C 格。
  - 桑薇是为了拦下署名有误的拷贝，想私下找许玛商量以后再拿回母带。没有其他人动过母带。
核实方式:
  物证: 展柜棉线和校准箱吊牌上散开的绳头可以互相印证。请工作人员开箱可核对轴芯编号。
  文件: 领用工单和清单独立证实谁在什么时候拿了空箱。曲目单、实际音频和两份打样审批可核实署名争议。
  人证: 罗安能说出是谁把箱子带往 C 格所在的走廊。桑薇也可能承认自己的行为，开箱核验依然有效。
`,
  },
  ...storyControlFiles(
    "zh-CN",
    "exhibition-room",
    `# 消失的母带

保管记录里是已经发生的事。让玩家通过查看展柜、实际试听、比较手续、问人或其他说得通的方法发现实情。供主持者查阅的材料与各人已经知道的事分开；证人可以诚实却只知道一部分。等玩家有机会接触线索时再把它写进叙事。母带和短版试音文件的内容及用途不同。

@case-notes#/已知线索 只记确实让玩家知道的观察或注明来源的证词。母带找到后将去向更新在 @reel-custody。人物做了新决定就推进当前情境。收运若如期发生，记录箱子去了哪里，玩家仍可继续追查。由玩家决定是否协调署名、保留证据、帮忙举办试听、通知某人或不再查案。不必取得口供才能查明经过。档案馆在这桩事过后还有日常工作。
`,
    ["case-notes", "reel-custody"],
    { document: "case-notes", key: "已知线索" },
  ),
];
