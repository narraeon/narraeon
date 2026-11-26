import type { ContentTreeFile } from "../../protocol/v1.ts";
import { storyControlFiles } from "./story-controls.ts";

export const screeningNightChinese: readonly ContentTreeFile[] = [
  {
    path: "opening.md",
    contents: `等你下课回来，那个写着“今晚放电影”的粉笔箭头已经指进了水洼。院子里，幕布的下沿慢慢洇成了灰色。彭涛把布从长凳上解下来，湿布一甩，轻轻给了他一耳光。

“四十六个人报名。”站在檐下的米娜说。她还别着图书馆的工牌，翻转手机让你看学生办公室的消息：只要六点前去领钥匙，204 教室就能用。里头二十八个座位。

“三部短片能不能分两轮放？”她问，“千万别让我发第三次改期通知。”

韩夏从笔记本电脑前抬起头。空格键旁边摊着一包芝麻饼干和一列她手敲的时间码。“我那个字幕还没试过。要不先找个干的地方校一遍？院子下星期又不会跑。”

彭涛把幕布团在怀里。“或者今晚去活动室凑一凑。我答应那两个通勤的同学，赶得上末班车再散。”

一分钟前，你还只想着散场以后去哪儿吃饭。现在米娜把手机递到你伸手就够得着的地方：“你说，我们到底怎么跟大家讲？”
`,
  },
  {
    path: "world/current-situation.yaml",
    contents: `$document:
  id: situation.screening-night
  ref: current-situation
  title: 湿幕布和备用钥匙
  summary: 电影社需要决定怎么通知等着今晚放映的人。
  aliases: []
背景:
  时间: 秋季学期，周四下午五点四十分
  地点: 花楸学院院子，图书馆屋檐下
在场:
  - { $ref: character.mina-shah }
  - { $ref: character.hana-kim }
  - { $ref: character.pablo-vega }
  - { $ref: character.player }
待回应:
  说话人: { $ref: character.mina-shah }
  原话: 你说，我们到底怎么跟大家讲？
  位置: 米娜把停在办公室消息上的手机递出来。玩家还没接，也没替社团作答。
眼前的安排:
  - 露天幕布已经解下，三部学生短片都没放。
  - 报名四十六人，204 教室只有二十八座，六点前要领钥匙。还没有人确认预约。
  - 社团可以发通知、改地点、调整形式或延期。玩家也可以只帮某个人，或者照原计划去吃饭。
`,
  },
  {
    path: "world/characters/player.yaml",
    contents: `$document:
  id: character.player
  ref: protagonist
  title: 玩家主角
  summary: 玩家扮演偶尔帮电影社的花楸学院学生。
  aliases: []
与社团的关系: 今天上课前帮忙画了指路牌，以前来过几次开放例会。
权限: 是朋友和偶尔帮忙的志愿者。可以提出方案、搭把手或婉拒，没担任能替社团拍板的职务。
`,
  },
  {
    path: "world/characters/mina.yaml",
    contents: `$document:
  id: character.mina-shah
  ref: mina
  title: 米娜
  summary: 电影社组织者，也是图书馆的晚班助理。
  aliases: []
动机: 想让交了作品的同学看到有人来看。也厌倦每次都由自己报坏消息，希望有人接手一件具体的事。
行事: 发消息像写公告。有人耐心问她，她才会讲最担心什么。有人真正帮了忙，她会记得。
认知:
  教室: 看过办公室消息，知道座位数和六点领钥匙的时限。现有预约时间里放不下两场。
  观众: 知道报名表有四十六个名字，还没核对谁要提早走，或韩夏在做怎样的无障碍准备。
课余: 下了图书馆的晚班喜欢坐在食堂吧台做填字。
`,
  },
  {
    path: "world/characters/hana.yaml",
    contents: `$document:
  id: character.hana-kim
  ref: hana
  title: 韩夏
  summary: 学生剪辑师、字幕制作者，也是其中一部短片的导演。
  aliases: []
动机: 想让舅舅下次能看懂她的短片，又不愿当着全社的人讲他为什么需要字幕。相比首映的名头，她更想先把片子试过一遍。
行事: 先说明字幕应当是什么效果，再把耳机递过来，让人自己听。
认知:
  字幕: 她的短片有一个长的静音镜头，之后字幕错开两秒。她知道是哪个镜头，还没修好导出。
  备选: 用耳机试过社团的笔记本，还不知道哪些人要赶末班车。
课余: 给选修的广播课录细碎的声音，剪片时会跟旁边的人换零食。
`,
  },
  {
    path: "world/characters/pablo.yaml",
    contents: `$document:
  id: character.pablo-vega
  ref: pablo
  title: 彭涛
  summary: 要乘车通学的学生，今天负责借幕布。
  aliases: []
动机: 想对留下帮忙的两位同学守约。只要及时通知原本来看电影的人，大家一起吃个饭也算没把通勤同学晾在一边。
行事: 通常先抱起要搬的东西，再开口表达意见。需要的话愿意问接驳车，或者陪大家去车站。
认知:
  承诺: 向两名通勤同学保证今天的安排能让他们赶上七点二十的末班车。两人已经帮忙搬了椅子，还没看见教室预约消息。
  活动室: 上个月办过一次安静的活动，知道椅子可移动，也知道那里得跟别人共用，不能大声放音。
课余: 常在活动室同一个桌边交换桌游和备用公交卡。
`,
  },
  {
    path: "world/locations/courtyard.yaml",
    contents: `$document:
  id: location.rowan-courtyard
  ref: courtyard
  title: 花楸学院院子
  summary: 图书馆、学生办公室和活动室之间的碰面地点。
  aliases: []
格局: 图书馆的屋檐只遮住墙边一窄条，草地和地上的粉笔箭头都露在雨里。有干燥的过道通往办公室和活动室。
现况: 积水没过最下面两级台阶。打湿的幕布和延长线应晾干后再使用。活动室附近有带顶棚的晾晒架。
日常: 天晴时有人在台阶上看书、写活动告示，傍晚从院子穿去食堂。
`,
  },
  {
    path: "world/locations/room-204.yaml",
    contents: `$document:
  id: location.rowan-room-204
  ref: room-204
  title: 204 研讨教室
  summary: 可坐电梯或走楼梯到达的备用室内放映地点。
  aliases: []
出入: 学生办公室可在六点前把钥匙交给社团志愿者。预约时间为六点到七点，七点以后是另一组的人。
设备: 一共二十八个位子，包含无障碍位置，有投影仪和立体声音箱。三部短片加介绍共三十五分钟，预约只够放一场。
日常: 学生社团可以预约使用。如果要多借一会儿，得跟下一组商量。
`,
  },
  {
    path: "world/locations/common-room.yaml",
    contents: `$document:
  id: location.rowan-common-room
  ref: common-room
  title: 活动室和食堂
  summary: 一间有餐食和可挪动椅子的共享空间，靠近去车站的通道。
  aliases: []
出入: 校内的人都可以来，要给吃饭和学习的人留桌子。共用约定要求放片时戴耳机。
设备: 有两张桌子旁边有空插座，晚饭供应到七点。纸质公告板上有志愿招募和公交时刻表。
日常: 去外郊的末班车七点二十分从正门外发车。走有顶过道，五分钟就能到正门。
`,
  },
  ...storyControlFiles(
    "zh-CN",
    "courtyard",
    `# 电影社的日常

座位、预约时限、放映长度、乘车和无障碍需求会实际影响安排。社团可以问人、折中或找到新的资源来改方案。玩家可以支持任何一边、提出新办法、只搭把手或让社团自己决定。朋友可以各有意见，第二天照样一起吃饭。剪片、上课、吃饭和等车也能成为后续情节。

把已经答应别人的事和已定的预约同随口提议分开。决定了什么、通知了谁，记到各自最合适的文档。时钟按实际经过的场景推进。等玩家和其他人物落实了安排再收束今晚，留下后续上课、排练或平常相处的空间。
`,
  ),
];
