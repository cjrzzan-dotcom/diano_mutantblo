

const path = require('path');

const MODE = process.env.MODE || 'test';

const DATA_FILE = path.join(
  __dirname,
  MODE === 'prod'
    ? (process.env.DATA_FILE_PROD || 'data_rpg_girin.json')
    : (process.env.DATA_FILE_TEST || 'data_rpg_test.json')
);

console.log("MONGO_URI 있음?", !!process.env.MONGO_URI);

const { MongoClient } = require('mongodb');

let mongoClient;
let db;
let playersCol;
let legacyGameCol;

let gameData = {};

(async () => {
  await connectDB();
  await migrateLegacyGameIfNeeded();
  await loadData();
})();


async function connectDB(){
  if (!process.env.MONGO_URI) {
    throw new Error('MONGO_URI 없음');
  }

  mongoClient = new MongoClient(process.env.MONGO_URI);
  await mongoClient.connect();

  db = mongoClient.db('rpg_bot');
  playersCol = db.collection('players');
  legacyGameCol = db.collection('game');

 

  console.log('✅ DB 연결 완료');
}


async function migrateLegacyGameIfNeeded(){
  const playerCount = await playersCol.countDocuments();

  // 이미 players 컬렉션 쓰고 있으면 마이그레이션 안 함
  if (playerCount > 0) {
    console.log('ℹ️ players 컬렉션 이미 존재 - 마이그레이션 생략');
    return;
  }

  const legacy = await legacyGameCol.findOne({ _id: 'main' });
  if (!legacy) {
    console.log('ℹ️ 기존 game/main 문서 없음 - 마이그레이션 생략');
    return;
  }

  const entries = Object.entries(legacy).filter(([key, value]) => {
    if (key === '_id') return false;
    if (!value || typeof value !== 'object') return false;
    return true;
  });

  if (!entries.length) {
    console.log('ℹ️ 마이그레이션할 플레이어 데이터 없음');
    return;
  }

  await playersCol.bulkWrite(
    entries.map(([userId, player]) => ({
      updateOne: {
        filter: { _id: userId },
        update: {
          $set: {
            ...player,
            userId
          }
        },
        upsert: true
      }
    }))
  );

  console.log(`✅ 기존 game/main → players 마이그레이션 완료 (${entries.length}명)`);
}

async function loadData(){
  if (!playersCol) throw new Error('playersCol 없음');

  gameData = {};

  const docs = await playersCol.find({}).toArray();

  for (const doc of docs) {
    const userId = doc._id;
    const merged = {
      ...getDefaultPlayer(userId),
      ...doc,
      userId
    };
    delete merged._id;
    gameData[userId] = merged;
  }

  console.log(`✅ 플레이어 ${docs.length}명 로드 완료`);
  return gameData;
}

async function savePlayer(playerOrUserId){
  if (!playersCol) throw new Error('playersCol 없음');

  const userId =
    typeof playerOrUserId === 'string'
      ? playerOrUserId
      : playerOrUserId?.userId;

  if (!userId) {
    throw new Error('savePlayer: userId 없음');
  }

  const player =
    typeof playerOrUserId === 'string'
      ? gameData[userId]
      : playerOrUserId;

  if (!player) {
    throw new Error(`savePlayer: player 없음 (${userId})`);
  }

  const doc = {
    ...player,
    userId
  };
  delete doc._id;

  await playersCol.updateOne(
    { _id: userId },
    { $set: doc },
    { upsert: true }
  );
}

async function saveData(){
  if (!playersCol) throw new Error('playersCol 없음');

  const entries = Object.entries(gameData || {}).filter(([userId, player]) => {
    return !!userId && !!player && typeof player === 'object';
  });

  // 빈 데이터로 전체 덮어쓰기 방지
  if (!entries.length) {
    console.log('⛔ saveData 차단: 저장할 플레이어가 없음');
    return;
  }

  await playersCol.bulkWrite(
    entries.map(([userId, player]) => {
      const doc = {
        ...player,
        userId
      };
      delete doc._id;

      return {
        updateOne: {
          filter: { _id: userId },
          update: { $set: doc },
          upsert: true
        }
      };
    })
  );

  console.log(`✅ saveData 완료 (${entries.length}명)`);
}


console.log("버전2");

const ALLOWED_CATEGORY_IDS = process.env.ALLOWED_CATEGORY_IDS
  ? process.env.ALLOWED_CATEGORY_IDS.split(',')
  : [];


const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  AttachmentBuilder,
} = require('discord.js');
const fs = require('fs');


const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

require('dotenv').config();

const AUTO_HUNT_CHARGE_MS = 1 * 60 * 1000; // 1분
const AUTO_HUNT_MAX_CHARGES = 50;
const AUTO_HUNT_TURNS = 500;


const ATTRIBUTE_MAX = 10;
const ATTRIBUTE_GOLD_COSTS = [100, 150, 250, 400, 700, 1000, 1500, 2200, 3000, 4500];
const ATTRIBUTE_CHANCES = [100, 95, 90, 80, 70, 55, 40, 30, 20, 10];

const ATTRIBUTE_REMOVE_COST = 3000;


function endBattle(player) {
  player.run = null;
}

async function safeDeleteReply(interaction, delay = 5000){
  setTimeout(async () => {
    try {
      await interaction.deleteReply();
    } catch (e) {}
  }, delay);
}

async function sendOrUpdateBattleMessage(interaction, player, payload){
  const channel = interaction.channel;

  try {
    if (player.battleMessageId) {
      const oldMsg = await channel.messages.fetch(player.battleMessageId);
      await oldMsg.edit(payload);
      return oldMsg;
    }
  } catch (e) {
    // 기존 메시지 없으면 새로 생성
  }

  const sent = await channel.send(payload);
  player.battleMessageId = sent.id;
  player.battleChannelId = channel.id;
  await saveData(gameData);
  return sent;
}

function clearBattleMessage(player){
  player.battleMessageId = null;
  player.battleChannelId = null;
}

function reviveIfRespawnReady(player){
  if(!player.run) return false;
  if(!player.run.isDown) return false;
  if(!player.respawnAt) return false;
  if(Date.now() < player.respawnAt) return false;

  player.run.isDown = false;
  player.hp = Math.max(1, Math.floor(player.maxHp));
  player.respawnAt = 0;
  return true;
}


function buildAttributeButtons(){
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('attr_fire').setLabel('🔥 화염').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('attr_ice').setLabel('❄️ 얼음').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('attr_lightning').setLabel('⚡ 번개').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('attr_nature').setLabel('🌿 자연').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('attr_dark').setLabel('🌑 어둠').setStyle(ButtonStyle.Secondary),
    )
  ];
}

function buildAttributeRemoveButtons(player){
  const buttons = [];

  if(player.attributes.화염 > 0)
    buttons.push(new ButtonBuilder().setCustomId('attr_remove_화염').setLabel('🔥 화염').setStyle(ButtonStyle.Danger));

  if(player.attributes.얼음 > 0)
    buttons.push(new ButtonBuilder().setCustomId('attr_remove_얼음').setLabel('❄️ 얼음').setStyle(ButtonStyle.Danger));

  if(player.attributes.번개 > 0)
    buttons.push(new ButtonBuilder().setCustomId('attr_remove_번개').setLabel('⚡ 번개').setStyle(ButtonStyle.Danger));

  if(player.attributes.자연 > 0)
    buttons.push(new ButtonBuilder().setCustomId('attr_remove_자연').setLabel('🌿 자연').setStyle(ButtonStyle.Danger));

  if(player.attributes.어둠 > 0)
    buttons.push(new ButtonBuilder().setCustomId('attr_remove_어둠').setLabel('🌑 어둠').setStyle(ButtonStyle.Danger));

  if(buttons.length === 0){
    return [];
  }

  return [new ActionRowBuilder().addComponents(buttons)];
}


function refreshAutoHuntCharges(player) {
  if (player.autoHuntCharges == null) player.autoHuntCharges = 0;
  if (!player.autoHuntLastChargeAt) player.autoHuntLastChargeAt = Date.now();

  const now = Date.now();
  const elapsed = now - player.autoHuntLastChargeAt;

  const gained = Math.floor(elapsed / AUTO_HUNT_CHARGE_MS);
  if (gained > 0) {
    player.autoHuntCharges = Math.min(
      AUTO_HUNT_MAX_CHARGES,
      player.autoHuntCharges + gained
    );

    player.autoHuntLastChargeAt += gained * AUTO_HUNT_CHARGE_MS;
  }
}

function getNextAutoHuntChargeRemain(player) {
  refreshAutoHuntCharges(player);

  if (player.autoHuntCharges >= AUTO_HUNT_MAX_CHARGES) return 0;

  const now = Date.now();
  const remain = AUTO_HUNT_CHARGE_MS - (now - player.autoHuntLastChargeAt);
  return Math.max(0, remain);
}

const GRADE_SELL_PRICE = {
  common: 50,
  uncommon: 100,
  rare: 300,
  epic: 800,
  legendary: 2000
};


function getWaveMonster(dungeonKey, idx){
  const dungeon = DUNGEONS[dungeonKey];
  if(!dungeon) return null;
  if(!Array.isArray(dungeon.waves)) return null;

  const base = dungeon.waves[idx];
  if(!base) return null;

  return {
    ...base,
    currentHp: base.hp,
    element: pick(ELEMENTS),
  };
}


function createRunIfNeeded(player, dungeonKey){
  if(!player.run || player.run.dungeon !== dungeonKey){
    player.run = {
      dungeon: dungeonKey,
      waveIndex: 0,
      target: null,
      nextTarget: null,
      kills: 0,
      lastDrops: [],
      isDown: false
    };

    const dungeon = DUNGEONS[dungeonKey];

    if(dungeon?.type === 'random'){
      player.run.nextTarget = getRandomMonster(dungeonKey);
    } else if(dungeon?.type === 'wave'){
      player.run.nextTarget = getWaveMonster(dungeonKey, 0);
    }
  }
}

function getItemSellPrice(item){
  if(!item) return 0;

  const base = GRADE_SELL_PRICE[item.grade || 'common'] || 50;

  const atk = item.atkBonus || 0;
  const def = item.defBonus || 0;
  const crit = item.critChanceBonus || 0;
  const critDmg = item.critDamageBonus || 0;
  const dodge = item.dodgeBonus || 0;

  const enhanceMap = item.elementEnhance || {};
  const enhanceTotal = Object.values(enhanceMap).reduce((a, b) => a + (b || 0), 0);




  const statValue =
    atk * 8 +
    def * 8 +
    crit * 12 +
    critDmg * 10 +
    dodge * 12;

  const enhanceValue = enhanceTotal * 25;

  const price = base + statValue + enhanceValue;

  return Math.max(10, Math.floor(price));
}


const IMAGE_PATH = path.join(__dirname, 'images');
const INTRO_DELAY_MS = 1000;
const TEMP_DROP_DELETE_MS = 5000;
const TOWN_CHANNEL_ID = '1487955862940024862';


const DUNGEON_CHANNELS_PROD = {
  '1487952892852965426': '초심자의숲',
  '1487952924092010667': '오색룡의둥지',
  '1487953115024982076': '지옥의관문',
  '1487953176677060780': '지옥의심장부',
  '1487953322160816148': '지옥의왕좌',
'1490976926762926100': '드높은천상',
'1491290801987391488': '깊은심연의숲',
};

const DUNGEON_CHANNELS_TEST = {
  '1488405763415212053': '초심자의숲',
  '테스트오색룡채널ID': '오색룡의둥지',
  '테스트지옥채널ID': '지옥의관문',
  '테스트천상채널ID': '드높은천상',
};



function getDungeonByChannel(channelId){
  return DUNGEON_CHANNELS[channelId] || null;
}

function isAllowedCategory(channel){
  if(ALLOWED_CATEGORY_IDS.length === 0) return true;
  return ALLOWED_CATEGORY_IDS.includes(channel.parentId);
}



const DUNGEON_CHANNELS = MODE === 'prod'
  ? DUNGEON_CHANNELS_PROD
  : DUNGEON_CHANNELS_TEST;

const DISPLAY_NAMES = {
  '초심자의숲': '초심자의 숲',
  '깊은심연의숲': '깊은심연의숲',
  '오색룡의둥지': '오색룡의 둥지',
  '지옥의관문': '지옥의 관문',
  '지옥의심장부': '지옥의 심장부',
  '지옥의왕좌': '지옥의 왕좌',
};

const SHOP = {
  small: { label: '💊 작은물약', heal: 10, price: 10 },
  mid: { label: '🍗 중간물약', heal: 30, price: 30 },
  big: { label: '🍖 큰물약', heal: 100, price: 100 },
  elixir: { label: '🧪 엘릭서', heal: 99999, price: 3000 },
};

const ELEMENTS = ['화염', '얼음', '번개', '자연', '어둠'];
const STRONG = { 화염: '자연', 자연: '번개', 번개: '얼음', 얼음: '화염', 어둠: '무속성' };
const STAT_CAPS = { critChance: 35, critDamage: 100, dodge: 25 };

const RARITIES = [
  { key: 'common', label: '일반', icon: '🟦', weight: 52, atk: 0, def: 0 },
  { key: 'rare', label: '레어', icon: '🟩', weight: 27, atk: 2, def: 2 },
  { key: 'epic', label: '에픽', icon: '🟨', weight: 12, atk: 4, def: 4 },
  { key: 'unique', label: '유니크', icon: '🟧', weight: 6, atk: 7, def: 7 },
  { key: 'legendary', label: '전설', icon: '🟥', weight: 3, atk: 11, def: 11 },
];

const MATERIALS = [
  '슬라임젤리', '늑대가죽', '고블린뼈조각', '오우거가죽', '작은 용비늘', '낡은장비조각',
  '드래곤 비늘', '드래곤 발톱', '번개조각', '얼음조각', '붉은화염조각', '푸른화염조각', '어둠조각',
  '좀비드래곤의 피', '메탈조각', '좀비드래곤의 가죽', '빛의 조각', '암흑의 조각',
  '도살자의 도끼조각', '레오릭왕의 뼈조각', '악마의 정수', '릴리트의 뿔', '디아블로의 뿔', '고급장비조각','천상의 조각','천상석',
];

const CRAFTS = [
  { id:'slime_sword', label:'슬라임검', type:'weapon', materials:{ '낡은장비조각':3, '슬라임젤리':5 }, base:{atk:8,def:0} },
  { id:'wolf_armor', label:'늑대가죽갑옷', type:'armor', materials:{ '낡은장비조각':3, '늑대가죽':5 }, base:{atk:0,def:8} },
  { id:'goblin_greatsword', label:'고블린대검', type:'weapon', materials:{ '낡은장비조각':5, '고블린뼈조각':5 }, base:{atk:13,def:0} },
  { id:'ogre_armor', label:'오우거가죽갑옷', type:'armor', materials:{ '낡은장비조각':5, '오우거가죽':5 }, base:{atk:0,def:14} },
  { id:'s_dragon_sword', label:'S드래곤검', type:'weapon', materials:{ '낡은장비조각':7, '작은 용비늘':3 }, base:{atk:20,def:0} },
  { id:'s_dragon_armor', label:'S드래곤갑옷', type:'armor', materials:{ '낡은장비조각':7, '작은 용비늘':3 }, base:{atk:0,def:20} },

  { id:'lightning_ring', label:'번개반지', type:'ring', materials:{ '번개조각':10 }, ringRandom:true, base:{atk:0,def:0} },
  { id:'ice_ring', label:'얼음반지', type:'ring', materials:{ '얼음조각':10 }, ringRandom:true, base:{atk:0,def:0} },
  { id:'red_ring', label:'붉은반지', type:'ring', materials:{ '붉은화염조각':10 }, ringRandom:true, base:{atk:0,def:0} },
  { id:'blue_ring', label:'푸른반지', type:'ring', materials:{ '푸른화염조각':10 }, ringRandom:true, base:{atk:0,def:0} },
  { id:'dark_ring', label:'어둠반지', type:'ring', materials:{ '어둠조각':10 }, ringRandom:true, base:{atk:0,def:0} },

  { id:'dragon_armor', label:'드래곤아머', type:'armor', materials:{ '낡은장비조각':5, '드래곤 비늘':7 }, base:{atk:0,def:28} },
  { id:'dragon_sword', label:'드래곤소드', type:'weapon', materials:{ '낡은장비조각':5, '드래곤 발톱':7 }, base:{atk:28,def:0} },
  { id:'zombie_sword', label:'좀비드래곤소드', type:'weapon', materials:{ '낡은장비조각':7, '좀비드래곤의 피':10 }, base:{atk:34,def:0} },
  { id:'metal_sword', label:'장군넴소드', type:'weapon', materials:{ '낡은장비조각':8, '메탈조각':5 }, base:{atk:38,def:0} },
  { id:'metal_armor', label:'장군넴아머', type:'armor', materials:{ '낡은장비조각':8, '메탈조각':10 }, base:{atk:0,def:38} },
  { id:'bald_armor', label:'대머리갑옷', type:'armor', materials:{ '낡은장비조각':9, '좀비드래곤의 가죽':5 }, base:{atk:0,def:43} },
  { id:'light_sword', label:'빛의검', type:'weapon', materials:{ '낡은장비조각':10, '빛의 조각':5 }, base:{atk:45,def:0} },
  { id:'light_armor', label:'암흑갑옷', type:'armor', materials:{ '낡은장비조각':10, '암흑의 조각':5 }, base:{atk:0,def:50} },

{ id:'butcher_axe', label:'도살자의도끼', type:'weapon', materials:{ '고급장비조각':10, '도살자의 도끼조각':15 }, base:{atk:52,def:0} },
{ id:'leoric_armor', label:'레오릭왕의갑옷', type:'armor', materials:{ '고급장비조각':15, '레오릭왕의 뼈조각':15 }, base:{atk:0,def:55} },
{ id:'demon_cloak', label:'악마의망토', type:'armor', materials:{ '고급장비조각':20, '악마의 살점':20 }, base:{atk:0,def:68} },
{ id:'demon_sword', label:'악마의검', type:'weapon', materials:{ '고급장비조각':20, '악마의 정수':20 }, base:{atk:70,def:0} },
{ id:'lilith_ring', label:'릴리트의 반지', type:'ring', materials:{ '릴리트의 뿔':20 }, ringRandom:true, base:{atk:0,def:0} },
{ id:'end_sword', label:'종말의검', type:'weapon', materials:{ '디아블로의 뿔':20 }, base:{atk:88,def:0} },

{ id:'lilith_sword', label:'천상의 심판', type:'weapon', materials:{ '천상의 조각':5, '천상석' :30 },  base:{atk:105,def:30} },
{ id:'end_armor', label:'천상의 갑주', type:'armor', materials:{ '천상의 조각':5, '천상석' :30 }, base:{atk:30,def:105} },


];

const CRAFT_BY_ID = Object.fromEntries(CRAFTS.map(v => [v.id, v]));

const DUNGEONS = {
  '초심자의숲': { type: 'random', autoAllowed: true, monsters: [
    { name: '슬라임', hp: 22, atk: 6, def: 0, gold: [5,10], xp: 8 },
    { name: '늑대', hp: 28, atk: 8, def: 0, gold: [8,14], xp: 10 },
    { name: '고블린', hp: 34, atk: 10, def: 1, gold: [10,16], xp: 12 },
    { name: '오크', hp: 52, atk: 14, def: 2, gold: [16,24], xp: 16 },
    { name: '오우거', hp: 82, atk: 18, def: 3, gold: [25,40], xp: 24 },
    { name: '드래곤', hp: 100, atk: 20, def: 5, gold: [50,80], xp: 45 },
  ]},
  '깊은심연의숲': { type: 'random', autoAllowed: true, monsters: [
    { name: '오크', hp: 52, atk: 14, def: 2, gold: [16,24], xp: 16 },
    { name: '오우거', hp: 82, atk: 18, def: 3, gold: [25,40], xp: 24 },
    { name: '드래곤', hp: 100, atk: 20, def: 5, gold: [50,80], xp: 45 },
    { name: '오크전사', hp: 120, atk: 22, def: 6, gold: [50,80], xp: 45 }, 
    { name: '오우거전사', hp: 150, atk: 22, def: 8, gold: [50,80], xp: 45 }, 
    { name: '심연의드래곤', hp: 180, atk: 25, def: 10, gold: [50,80], xp: 45 }, 
  ]},
  '오색룡의둥지': { type: 'random', autoAllowed: true, monsters: [
    { name: '번개드래곤', hp: 350, atk:  40, def: 10, gold: [80,100], xp: 50 },
    { name: '얼음드래곤', hp: 400, atk: 42, def: 12, gold: [80,100], xp: 50 },
    { name: '붉은화염드래곤', hp: 450, atk: 44, def: 14, gold: [80,100], xp: 50 },
    { name: '푸른화염드래곤', hp: 500, atk: 46, def: 14, gold: [80,100], xp: 50 },
    { name: '어둠드래곤', hp: 550, atk: 46, def: 14, gold: [80,100], xp: 50 },
    { name: '좀비드래곤', hp: 800, atk: 50, def: 15, gold: [100,120], xp: 52 },
    { name: '메탈드래곤', hp: 1000, atk: 65, def: 20, gold: [120,140], xp: 65 },
    { name: '대독드래곤', hp: 1000, atk: 60, def: 20, gold: [140,150], xp: 70 },
    { name: '빛의 군주 드래곤', hp: 1200, atk: 70, def: 25, gold: [150,200], xp: 80 },
    { name: '암흑의 군주 드래곤', hp: 1300, atk: 75, def: 30, gold: [200,300], xp: 100 },
    { name: '창조 드래곤', hp: 1500, atk: 80, def: 35, gold: [100,150], xp: 120 },
    { name: '메이드빵게드래곤', hp: 100, atk: 50, def: 30, gold: [3000,5000], xp: 200 },
    { name: '요리사응구드래곤', hp: 100, atk: 50, def: 30, gold: [5000,10000], xp: 300 },
    { name: '에인절라스드래곤', hp: 100, atk: 50, def: 30, gold: [1000,1500], xp: 500 },


  ]},
  '지옥의관문': { type: 'wave', autoAllowed: false, waves: [
    { name: '도살자', hp: 750, atk: 60, def: 30, gold: [70,100], xp: 60 },
    { name: '레오릭 왕', hp: 800, atk: 70, def: 35, gold: [100,150], xp: 70 },
    { name: '두리엘', hp: 900, atk: 80, def: 40, gold: [150,200], xp: 84 },
    { name: '안다리엘', hp: 950, atk: 90, def: 45, gold: [200,250], xp: 88 },
    { name: '벨리알', hp: 1000, atk: 100, def: 50, gold: [250,300], xp: 96 },
    { name: '아즈모단', hp: 1100, atk: 110, def: 55, gold: [300,350], xp: 105 },
    { name: '릴리트', hp: 1300, atk: 120, def: 60, gold: [600,700], xp: 120 },
    { name: '바알', hp: 1500, atk: 130, def: 65, gold: [700,800], xp: 130 },
    { name: '메피스토', hp: 1700, atk: 140, def: 70, gold: [800,900], xp: 140 },
    { name: '디아블로', hp: 2000, atk: 150, def: 75, gold: [900,1000], xp: 150 },
    { name: '종말의 화신 디아블로', hp: 4000, atk: 200, def: 80, gold: [1000,1500], xp: 220 },
  ]},
  '지옥의심장부': { type: 'wave', autoAllowed: false, waves: [
    { name: '우버 레오릭 왕', hp: 5000, atk: 210, def: 82, gold: [1800,2000], xp: 120 },
    { name: '우버 안다리엘', hp: 5500, atk: 230, def: 84, gold: [2000,2200], xp: 135 },
    { name: '우버 두리엘', hp: 6000, atk: 250, def: 86, gold: [2200,2400], xp: 145 },
    { name: '우버 바알', hp: 6500, atk: 270, def: 88, gold: [2400,2600], xp: 165 },
    { name: '우버 디아블로', hp: 7000, atk: 290, def: 90, gold: [2600,2800], xp: 175 },
    { name: '우버 메피스토', hp: 7500, atk: 310, def: 92, gold: [2800,3000], xp: 182 },
    { name: '우버 릴리트', hp: 8000, atk: 350, def: 94, gold: [3000,3200], xp: 190 },
    { name: '우버 종말의 화신 디아블로', hp: 10000, atk: 400, def: 100, gold: [3500,4000], xp: 260 },
  ]},
'드높은천상': { type: 'random', autoAllowed: false, monsters: [
  { name: '아우리엘', hp: 9000, atk: 360, def: 100, gold: [3200,3600], xp: 210 },
  { name: '이테리엘', hp: 10000, atk: 380, def: 100, gold: [3400,3800], xp: 220 },
  { name: '말티엘', hp: 13000, atk: 430, def: 100, gold: [4200,4800], xp: 260 },
  { name: '임페리우스', hp: 16000, atk: 480, def: 100, gold: [5200,6000], xp: 320 },
  { name: '티리엘', hp: 22000, atk: 520, def: 100, gold: [8000,10000], xp: 500 },
]},
  '지옥의왕좌': { type: 'wave', autoAllowed: false, waves: [
    { name: '증오의 군주 디아블로', hp: 15000, atk: 450, def: 120, gold: [10000,10000], xp: 300 },
    { name: '파괴의 군주 디아블로', hp: 20000, atk: 500, def: 120, gold: [10000,12000], xp: 500 },
    { name: '만악의 군주 디아블로', hp: 25000, atk: 550, def: 120, gold: [13000,15000], xp: 800 },
  ]},
};

function rand(min,max){ return Math.floor(Math.random()*(max-min+1))+min; }
function chance(percent){ return Math.random()*100 < percent; }
function pick(arr){ return arr[Math.floor(Math.random()*arr.length)]; }
function sleep(ms){ return new Promise(resolve => setTimeout(resolve, ms)); }
function round1(v){ return Math.round(v*10)/10; }

const BACKUP_DIR = path.join(__dirname, 'backup');
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });


function isEquippedItem(player, item){
  return (
    player.equipment.weapon === item ||
    player.equipment.armor === item ||
    player.equipment.ring === item
  );
}
function makeDamageLine(attackerName, targetName, damage, crit = false) {
  const fx = crit ? '⚡💥 치명타!' : '💥';
  return `${attackerName} ${fx} ${targetName}에게 **${damage}** 피해!`;
}

function makeEnemyDamageLine(enemyName, damage) {
  return `👿 ${enemyName}의 반격! → **${damage}** 피해!`;
}

function makeDodgeLine() {
  return `💨 회피 성공!`;
}

function makeKillLine(name) {
  return `☠️ **${name} 처치!**`;
}

async function safeDeleteReply(interaction, delay = 8000){
  setTimeout(async () => {
    try {
      await interaction.deleteReply();
    } catch (e) {}
  }, delay);
}

function cleanupOldBackups(keepCount = 10){
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('data_rpg_girin_') && f.endsWith('.json'))
      .map(f => ({
        name: f,
        time: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs
      }))
      .sort((a, b) => b.time - a.time);

    const remove = files.slice(keepCount);
    for (const file of remove) {
      fs.unlinkSync(path.join(BACKUP_DIR, file.name));
    }
  } catch (e) {
    console.error('백업 정리 실패', e);
  }
}

function blankMaterials(){
  const out = {};
  for(const m of MATERIALS) out[m] = 0;
  return out;
}
function defaultEquipment(){
  return { weapon:null, armor:null, ring:null };
}
function getDefaultPlayer(userId){
  return {
    userId,
    level: 1,
    xp: 0,
    nextXp: 50,
    statPoints: 0,
    maxHp: 100,
    hp: 100,
    baseAtk: 12,
    baseDef: 3,
    gold: 100,
    reviveTickets: 0,
    respawnAt: 0,
    stones: { 화염:0, 얼음:0, 번개:0, 자연:0, 어둠:0 },
    attributes: {},
    potions: { small:2, mid:1, big:0, elixir:0 },
    materials: blankMaterials(),
    inventory: [],
    equipment: defaultEquipment(),
    stats: { atk:0, critChance:0, critDamage:0, dodge:0 },
    run: null,
    selectedEnhanceTarget: null,
    autoHuntCharges: 10,
    autoHuntLastChargeAt: Date.now(),
    battleMessageId: null,
    battleChannelId: null
  };
}




function getPlayer(userId) {
  if (!gameData) gameData = {}; // ⭐ 이 줄 추가

  if (!gameData[userId]) {
    gameData[userId] = getDefaultPlayer(userId);
  }
  return gameData[userId];
}


function getRandomMonster(dungeonKey) {
  const dungeon = DUNGEONS[dungeonKey];
  if (!dungeon || !Array.isArray(dungeon.monsters) || dungeon.monsters.length === 0) {
    return null;
  }

  let base = null;
  const monsters = dungeon.monsters;

  // =========================
  // 초심자의 숲 확률
  // =========================
  if (dungeonKey === '초심자의숲') {
    const roll = Math.random() * 100;

    if (roll < 40) {
      base = monsters[0]; // 슬라임
    } else if (roll < 70) {
      base = monsters[1]; // 늑대
    } else if (roll < 82) {
      base = monsters[2]; // 고블린
    } else if (roll < 92) {
      base = monsters[3]; // 오크
    } else if (roll < 97) {
      base = monsters[4]; // 오우거
    } else {
      base = monsters[5]; // 드래곤
    }
  }


else if (dungeonKey === '깊은심연의숲') {
  const roll = Math.random() * 100;

  if (roll < 25) {
    base = monsters[0]; // 오크
  } else if (roll < 50) {
    base = monsters[1]; // 오우거
  } else if (roll < 70) {
    base = monsters[2]; // 드래곤
  } else if (roll < 85) {
    base = monsters[3]; // 오크전사
  } else if (roll < 95) {
    base = monsters[4]; // 오우거전사
  } else {
    base = monsters[5]; // 심연의드래곤
  }
}

  // =========================
  // 오색룡의 둥지 확률
  // =========================
  else if (dungeonKey === '오색룡의둥지') {
    const roll = Math.random() * 100;

    if (roll < 7) {
      base = monsters.find(m => m.name === '좀비드래곤');
    } else if (roll < 11) {
      base = monsters.find(m => m.name === '메탈드래곤');
    } else if (roll < 15) {
      base = monsters.find(m => m.name === '대독드래곤');
    } else if (roll < 18) {
      base = monsters.find(m => m.name === '빛의 군주 드래곤');
    } else if (roll < 20) {
      base = monsters.find(m => m.name === '암흑의 군주 드래곤');
    } else if (roll < 21) {
      base = monsters.find(m => m.name === '창조 드래곤');
    } else if (roll < 21.3) {
      base = monsters.find(m => m.name === '요리사응구드래곤');
    } else if (roll < 21.8) {
      base = monsters.find(m => m.name === '메이드빵게드래곤');
    } else if (roll < 21.9) {
      base = monsters.find(m => m.name === '에인절라스드래곤');
    } else {
      const dragonPool = [
        '번개드래곤',
        '얼음드래곤',
        '붉은화염드래곤',
        '푸른화염드래곤',
        '어둠드래곤'
      ];
      const pickName = pick(dragonPool);
      base = monsters.find(m => m.name === pickName);
    }
  }

  // =========================
  // 드높은천상 확률
  // =========================
  else if (dungeonKey === '드높은천상') {
    const roll = Math.random() * 100;

    if (roll < 45) {
      base = monsters.find(m => m.name === '아우리엘');
    } else if (roll < 84.9) {
      base = monsters.find(m => m.name === '이테리엘');
    } else if (roll < 94.9) {
      base = monsters.find(m => m.name === '말티엘');
    } else if (roll < 99.9) {
      base = monsters.find(m => m.name === '임페리우스');
    } else {
      base = monsters.find(m => m.name === '티리엘');
    }
  }

  // =========================
  // 기타 랜덤 던전
  // =========================
  else {
    base = pick(monsters);
  }

  // 이름 오타/누락 등으로 못 찾았을 때 안전 fallback
  if (!base) {
    console.log('base 없음, fallback 사용. dungeonKey =', dungeonKey);
    base = pick(monsters);
  }

  return {
    ...base,
    currentHp: base.hp,
    element: pick(ELEMENTS),
  };
}

function getFileCandidate(name){
  const candidates = ['.png','.jpg','.jpeg','.webp'].map(ext => path.join(IMAGE_PATH, `${name}${ext}`));
  for(const f of candidates) if(fs.existsSync(f)) return f;
  return null;
}
function buildImageAttachment(name){
  const file = getFileCandidate(name);
  if(!file) return null;
  const ext = path.extname(file).toLowerCase();
  const safe = `${name.replace(/[^\w가-힣]/g,'_')}${ext}`;
  return { attachment:new AttachmentBuilder(file,{name:safe}), embedUrl:`attachment://${safe}` };
}
function getLevelUpAttachment(){ return buildImageAttachment('levelup') || buildImageAttachment('레벨업'); }
function getDeathAttachment(){ return buildImageAttachment('death') || buildImageAttachment('죽음'); }

function getRarityByKey(key){ return RARITIES.find(v=>v.key===key) || RARITIES[0]; }
function rollRarity(){
  const total = RARITIES.reduce((a,v)=>a+v.weight,0);
  let r = Math.random()*total;
  for(const v of RARITIES){
    r -= v.weight;
    if(r <= 0) return v;
  }
  return RARITIES[0];
}
function createRingStats(){
  const count = rand(1,3);
  const pool = ['critChanceBonus','critDamageBonus','dodgeBonus'];
  const picked = [];

  while(picked.length < count){
    const k = pick(pool);
    if(!picked.includes(k)) picked.push(k);
  }

  const out = { critChanceBonus:0, critDamageBonus:0, dodgeBonus:0 };
  for(const k of picked) out[k] = rand(2,5);
  return out;
}
function createCraftItem(recipe){
  const rarity = rollRarity();
  const item = {
    name: `${rarity.icon} ${recipe.label}`,
    type: recipe.type,
    rarity: rarity.key,
    rarityLabel: rarity.label,
    atkBonus: recipe.base.atk + rarity.atk,
    defBonus: recipe.base.def + rarity.def,
    critChanceBonus: 0,
    critDamageBonus: 0,
    dodgeBonus: 0,
    elementEnhance: {},
  };
  if(recipe.ringRandom){
    Object.assign(item, createRingStats());
  }
  return item;
}

function getEquippedBonuses(player){
  const bonus = { atk:0, def:0, critChance:0, critDamage:0, dodge:0 };
  for(const item of Object.values(player.equipment)){
    if(!item) continue;
    bonus.atk += item.atkBonus || 0;
    bonus.def += item.defBonus || 0;
    bonus.critChance += item.critChanceBonus || 0;
    bonus.critDamage += item.critDamageBonus || 0;
    bonus.dodge += item.dodgeBonus || 0;
  }
  return bonus;
}
function getAttackPower(player){
  const eq = getEquippedBonuses(player);
  return player.baseAtk + player.stats.atk * 1 + eq.atk;
}

function getDefensePower(player){
  const eq = getEquippedBonuses(player);
  return player.baseDef + Math.floor(player.level / 3) + eq.def;
}
function getCritChance(player){
  const eq = getEquippedBonuses(player);
  return round1(Math.min(STAT_CAPS.critChance, player.stats.critChance + eq.critChance));
}
function getCritDamage(player){
  const eq = getEquippedBonuses(player);
  return round1(Math.min(STAT_CAPS.critDamage, player.stats.critDamage + eq.critDamage));
}
function getDodge(player){
  const eq = getEquippedBonuses(player);
  return round1(Math.min(STAT_CAPS.dodge, player.stats.dodge + eq.dodge));
}
function getAttributeBonus(attrs){
  return Object.values(attrs).reduce((a,c)=>a+c,0);
}
function getElementMultiplier(playerAttrs, monsterElement){
  const attrs = Object.keys(playerAttrs).slice(0,2);
  if(!attrs.length) return 1.0;
  let strong = false, weak = false;
  for(const a of attrs){
    if(STRONG[a] === monsterElement) strong = true;
    if(STRONG[monsterElement] === a) weak = true;
  }
  if(strong) return 1.2;
  if(weak) return 0.8;
  return 1.0;
}

function grantMaterial(player, name, amount, lines){
  player.materials[name] = (player.materials[name] || 0) + amount;
  lines.push(`📦 ${name} +${amount}`);
}
function getMaterialDrops(monsterName){
  const drops = [];
  if(chance(40)) drops.push(['낡은장비조각',1]);
  switch(monsterName){
    case '슬라임': if(chance(45)) drops.push(['슬라임젤리',1]); break;
    case '늑대': if(chance(40)) drops.push(['늑대가죽',1]); break;
    case '고블린': if(chance(35)) drops.push(['고블린뼈조각',1]); break;
    case '오크': if(chance(30)) drops.push(['오우거가죽',1]); break;
    case '오우거': if(chance(30)) drops.push(['오우거가죽',1]); break;
    case '드래곤': if(chance(30)) drops.push(['작은 용비늘',1]); break;
    case '오크전사': if(chance(35)) drops.push(['오우거가죽',2]); break;
    case '오우거전사': if(chance(35)) drops.push(['고급장비조각',2]); break;
    case '심연의드래곤': drops.push(['작은 용비늘',2]); if(chance(35)) drops.push(['드래곤 비늘',1]); break;
  }

  const dragonSet = ['번개드래곤','얼음드래곤','붉은화염드래곤','푸른화염드래곤','어둠드래곤','좀비드래곤','메탈드래곤','대독드래곤','빛의 군주 드래곤','암흑의 군주 드래곤','창조 드래곤','에인절라스드래곤','요리사응구드래곤','메이드빵게드래곤'];
  if(dragonSet.includes(monsterName)){
    if(chance(35)) drops.push(['드래곤 비늘',1]);
    if(chance(35)) drops.push(['드래곤 발톱',1]);
    if(chance(35)) drops.push(['낡은장비조각',1]);
  }

  switch(monsterName){
    case '번개드래곤': if(chance(40)) drops.push(['번개조각',1]); break;
    case '얼음드래곤': if(chance(40)) drops.push(['얼음조각',1]); break;
    case '붉은화염드래곤': if(chance(40)) drops.push(['붉은화염조각',1]); break;
    case '푸른화염드래곤': if(chance(40)) drops.push(['푸른화염조각',1]); break;
    case '어둠드래곤': if(chance(40)) drops.push(['어둠조각',1]); break;
    case '좀비드래곤': if(chance(40)) drops.push(['좀비드래곤의 피',1]); break;
    case '메탈드래곤': if(chance(30)) drops.push(['메탈조각',1]); break;
    case '대독드래곤': if(chance(30)) drops.push(['좀비드래곤의 가죽',1]); break;
    case '빛의 군주 드래곤': if(chance(30)) drops.push(['빛의 조각',1]); break;
    case '암흑의 군주 드래곤': if(chance(40)) drops.push(['암흑의 조각',1]); break;
    case '창조 드래곤': if(chance(50)) drops.push(['빛의 조각',3]); break;
    case '에인절라스드래곤': drops.push(['부활권',5]); break;
    case '티리엘': drops.push(['천상의 조각',1]); break;
}
const heavenSet = ['아우리엘','이테리엘','말티엘','임페리우스','티리엘'];

if(heavenSet.includes(monsterName)){
  if(chance(40)) drops.push(['천상석',1]);

  }

 const hellGate = ['도살자','레오릭 왕','두리엘','안다리엘','벨리알','아즈모단','릴리트','바알','메피스토','디아블로','종말의 화신 디아블로'];
  if(hellGate.includes(monsterName) && chance(40)) drops.push(['고급장비조각',1]);

  if(monsterName === '도살자' && chance(40)) drops.push(['도살자의 도끼조각',1]);
  if(monsterName === '레오릭 왕' && chance(40)) drops.push(['레오릭왕의 뼈조각',1]);
  if(['두리엘','안다리엘','벨리알','아즈모단'].includes(monsterName) && chance(40)) drops.push(['악마의 살점',1]);
  if(monsterName === '릴리트' && chance(35)) drops.push(['릴리트의 뿔',1]);
  if(['바알','메피스토','디아블로'].includes(monsterName) && chance(40)) drops.push(['악마의 정수',1]);
  if(monsterName === '종말의 화신 디아블로' && chance(40)) drops.push(['디아블로의 뿔',1]);

  return drops;
}

function getEnhanceTargetItem(player){
  const target = player.selectedEnhanceTarget;
  if(!target) return null;

  if(target.type === 'inventory'){
    return player.inventory[target.index] || null;
  }

  if(target.type === 'equipped'){
    return player.equipment[target.slot] || null;
  }

  return null;
}

function giveXp(player, amount){
  player.xp += amount;
  const msgs = [];
  while(player.xp >= player.nextXp){
    player.xp -= player.nextXp;
    player.level += 1;
    player.nextXp = Math.floor(player.nextXp * 1.25);
    player.maxHp += 12;
    player.hp = player.maxHp;
    player.statPoints += 3;
    msgs.push(`Lv.${player.level} 달성! 스탯포인트 +3`);
  }
  return msgs;
}
function grantDrops(player, monster){
  const lines = [];
  const gold = rand(monster.gold[0], monster.gold[1]);
  player.gold += gold;
  lines.push(`💰 골드 +${gold}`);

  if(chance(15)){
    player.stones[monster.element] += 1;
    lines.push(`💎 ${monster.element}석 +1`);
  }

for(const [name, amount] of getMaterialDrops(monster.name)){
  if(name === '부활권'){
    player.reviveTickets += amount;
    lines.push(`💖 부활권 +${amount}`);
  } else {
    grantMaterial(player, name, amount, lines);
  }
}

  let reviveChance = 0.3;
  if(monster.name.includes('드래곤')) reviveChance = 0.8;
  if(monster.name.includes('우버')) reviveChance = 2.5;
  if(monster.name.includes('군주') || monster.name.includes('디아블로') || monster.name.includes('메피스토') || monster.name.includes('바알') || monster.name.includes('릴리트')) reviveChance = 2;
  if(chance(reviveChance)){
    player.reviveTickets += 1;
    lines.push('💖 부활권 +1');
  }

  lines.push(`✨ 경험치 +${monster.xp}`);
  const levelUps = giveXp(player, monster.xp);
  lines.push(...levelUps.map(v => `🎉 ${v}`));
  return { lines, levelUps };
}

function handleNoReviveDeath(player){
  player.run = null;
  player.hp = player.maxHp;
  player.respawnAt = Date.now() + 3*60*1000;
}

function getEnhancePreviewText(player, item){
  if(!item) return '선택한 아이템이 없습니다.';

  const goldCosts = [100, 150, 250, 400, 700, 1000, 1500, 2200, 3000, 4500];
  const chances   = [100, 95, 90, 80, 70, 55, 40, 30, 20, 10];
  const maxLevel = 10;

  const current = item.enhanceLevel || 0;

  if(current >= maxLevel){
    return [
      `선택 아이템: ${item.name}${getEnhanceLevelText(item)}${getItemStatText(item)}`,
      `현재 강화: +${current}`,
      `최대 강화입니다.`
    ].join('\n');
  }

  const failText = current >= 7 ? '실패 시 1단계 하락' : '실패 시 하락 없음';

  return [
    `선택 아이템: ${item.name}${getEnhanceLevelText(item)}${getItemStatText(item)}`,
    `현재 강화: +${current}`,
    `다음 강화: +${current + 1}`,
    `비용: ${goldCosts[current]}G`,
    `성공 확률: ${chances[current]}%`,
    failText
  ].join('\n');
}


function enemyAttack(player, target, logs){
  if(!target || target.currentHp <= 0 || !player.run || player.run.isDown) return;

  if(chance(getDodge(player))){
    logs.push(makeDodgeLine());
    return;
  }

  const dmg = Math.max(1, target.atk - getDefensePower(player));
  player.hp -= dmg;
  logs.push(makeEnemyDamageLine(target.name, dmg));

  if(player.hp <= 0){
    player.hp = 0;
    player.respawnAt = Date.now() + 15 * 60 * 1000;

    if(player.reviveTickets > 0){
      player.run.isDown = true;
      logs.push('💀 쓰러졌습니다! [부활권]으로 즉시 부활하거나 15분 후 자동 부활합니다.');
    } else {
      player.run.isDown = true;
      logs.push('💀 사망! 부활권이 없어 15분 후 자동 부활합니다.');
    }
  }
}

function applyAutoHuntPenalty(result) {
  if (!result) return result;

  // 경험치
  if (typeof result.exp === 'number') {
    result.exp = Math.max(1, Math.floor(result.exp / 5));
  }

  // 골드
  if (typeof result.gold === 'number') {
    result.gold = Math.max(1, Math.floor(result.gold / 5));
  }

  // 드랍 아이템 수량
  if (Array.isArray(result.drops)) {
    result.drops = result.drops.map(drop => ({
      ...drop,
      amount: Math.max(1, Math.floor((drop.amount || 1) / 5))
    }));
  }

  return result;
}

function usePotionOutOfBattle(player, key){
  const item = SHOP[key];
  if(!item) return '잘못된 물약입니다.';
  if((player.potions[key]||0) <= 0) return `${item.label}이 없습니다.`;
  player.potions[key] -= 1;
  player.hp = Math.min(player.maxHp, player.hp + item.heal);
  return `${item.label} 사용! HP ${player.hp}/${player.maxHp}`;
}
function usePotionInBattle(player, key){
  const item = SHOP[key];
  if(!item) return { logs:['잘못된 물약입니다.'] };
  if((player.potions[key]||0) <= 0) return { logs:[`${item.label}이 없습니다.`] };
  if(!player.run?.target) return { logs:['현재 전투 중인 몬스터가 없습니다.'] };
  if(player.run.isDown) return { logs:['쓰러진 상태입니다. 먼저 부활권을 사용하세요.'] };
  player.potions[key] -= 1;
  player.hp = Math.min(player.maxHp, player.hp + item.heal);
  const logs = [`${item.label} 사용! HP ${player.hp}/${player.maxHp}`];
  enemyAttack(player, player.run.target, logs);
  return { logs };
}


function performAttack(player, dungeonKey){
  const result = { logs:[], killedTarget:null, levelUps:[], clearedDungeon:false };

  const revived = reviveIfRespawnReady(player);
  if(revived){
    result.logs.push('✨ 부활 시간이 지나 자동으로 부활했습니다.');
  }

  createRunIfNeeded(player, dungeonKey);

  if(player.run.isDown){
    result.logs.push('쓰러진 상태입니다. 먼저 부활권을 사용하거나 부활 시간을 기다리세요.');
    return result;
  }

  if(!player.run.target){
    if(player.run.nextTarget){
      player.run.target = player.run.nextTarget;
      player.run.nextTarget = null;
      result.logs.push(`✨ 다음 몬스터 매칭: ${player.run.target.name} (${player.run.target.element})`);
      return result;
    }
    result.logs.push('현재 매칭 가능한 몬스터가 없습니다.');
    return result;
  }

const target = player.run.target;
const mult = getElementMultiplier(player.attributes, target.element);
const attrBonus = getAttributeBonus(player.attributes);

let damage = (getAttackPower(player) * mult) + attrBonus - target.def;
let isCrit = false;


if (mult > 1) {
  result.logs.push(`🔥 속성 우위! 데미지 ${mult}배 적용`);
} else if (mult < 1) {
  result.logs.push(`💧 속성 열세! 데미지 ${mult}배 적용`);
}


if(chance(getCritChance(player))){
  damage *= 1.5 + (getCritDamage(player)/100);
  isCrit = true;
}

damage = Math.max(1, Math.floor(damage));

target.currentHp -= damage;
result.logs.push(makeDamageLine('👤 플레이어', target.name, damage, isCrit));


if(target.currentHp <= 0){
  target.currentHp = 0;
  result.killedTarget = { ...target };
  result.logs.push(makeKillLine(target.name));

  const drops = grantDrops(player, target);
  result.levelUps = drops.levelUps;
  player.run.lastDrops = drops.lines;
  result.logs.push(...drops.lines);
  player.run.kills += 1;

  const dungeon = DUNGEONS[dungeonKey];

  // 현재 타겟 제거
  player.run.target = null;

  // 랜덤 던전이면 전투 종료
  if(dungeon.type === 'random'){
    endBattle(player);
    result.logs.push('🏘️ 전투 종료! 이제 마을 기능을 사용할 수 있습니다.');
    return result;
  }

  // 웨이브 던전이면 다음 웨이브 지정
  if(dungeon.type === 'wave'){
    player.run.waveIndex += 1;
    player.run.nextTarget = getWaveMonster(dungeonKey, player.run.waveIndex);

    if(player.run.nextTarget){
      result.logs.push(`✨ 다음 몬스터 매칭 예정: ${player.run.nextTarget.name}`);
    } else {
      result.logs.push('🏆 모든 웨이브를 클리어했습니다!');
      endBattle(player);
    }

    return result;
  }


    player.run.waveIndex += 1;
    const next = getWaveMonster(dungeonKey, player.run.waveIndex);

    if(!next){
      player.run.target = null;
      player.run.nextTarget = null;
      player.run = null;
      result.clearedDungeon = true;
      result.logs.push(`🏆 ${DISPLAY_NAMES[dungeonKey]} 클리어!`);
      return result;
    }

    player.run.target = null;
    player.run.nextTarget = next;
    result.logs.push('다음 웨이브는 [공격] 버튼을 눌러 매칭하세요.');
    return result;
  }

  enemyAttack(player, target, result.logs);
  return result;
}

function tryUpgradeStat(player, key){
  if(player.statPoints <= 0) return '스탯포인트가 없습니다.';
  if(key === 'atk'){ player.stats.atk += 1; player.statPoints -= 1; return `⚔️ 공격 스탯 상승! 현재 ${player.stats.atk}`; }
  if(key === 'critChance'){
    if(getCritChance(player) >= STAT_CAPS.critChance) return '💥 크리확률은 이미 최대치입니다.';
    player.stats.critChance = round1(Math.min(STAT_CAPS.critChance, player.stats.critChance + 0.5));
    player.statPoints -= 1;
    return `💥 크리확률 상승! 현재 ${getCritChance(player)}%`;
  }
  if(key === 'critDamage'){
    if(getCritDamage(player) >= STAT_CAPS.critDamage) return '🔥 크리데미지는 이미 최대치입니다.';
    player.stats.critDamage = round1(Math.min(STAT_CAPS.critDamage, player.stats.critDamage + 1));
    player.statPoints -= 1;
    return `🔥 크리데미지 상승! 현재 +${getCritDamage(player)}%`;
  }
  if(key === 'dodge'){
    if(getDodge(player) >= STAT_CAPS.dodge) return '💨 회피는 이미 최대치입니다.';
    player.stats.dodge = round1(Math.min(STAT_CAPS.dodge, player.stats.dodge + 0.5));
    player.statPoints -= 1;
    return `💨 회피 상승! 현재 ${getDodge(player)}%`;
  }
  return '알 수 없는 스탯입니다.';
}
function canCraft(player, recipe){
  for(const [mat, need] of Object.entries(recipe.materials)){
    if((player.materials[mat]||0) < need) return false;
  }
  return true;
}
function tryCraft(player, craftId){
  const recipe = CRAFT_BY_ID[craftId];
  if(!recipe) return { ok:false, text:'없는 제작식입니다.' };
  if(!canCraft(player, recipe)) return { ok:false, text:'재료가 부족합니다.' };
  for(const [mat, need] of Object.entries(recipe.materials)){
    player.materials[mat] -= need;
  }
  const item = createCraftItem(recipe);
  player.inventory.push(item);
  return { ok:true, item, text:`🛠️ 제작 성공!\n${item.name}` };
}
function equipItemByIndex(player, idx){
  const item = player.inventory[idx];
  if(!item) return '없는 아이템입니다.';
  const slot = item.type;
  if(!['weapon','armor','ring'].includes(slot)) return '장착 가능한 아이템이 아닙니다.';
  if(player.equipment[slot]) player.inventory.push(player.equipment[slot]);
  player.equipment[slot] = item;
  player.inventory.splice(idx,1);
  return `✅ ${item.name} 장착 완료!`;
}


function getEnhanceLevelText(item){
  if(!item || !item.enhanceLevel) return '';
  return ` [+${item.enhanceLevel}]`;
}


function tryEnhanceItem(player, item){
  if(!item) return '없는 아이템입니다.';

  if(item.enhanceLevel === undefined) item.enhanceLevel = 0;

  const current = item.enhanceLevel;

  const goldCosts = [100, 150, 250, 400, 700, 1000, 1500, 2200, 3000, 4500];
  const chances   = [1.00, 0.95, 0.90, 0.80, 0.70, 0.55, 0.40, 0.30, 0.20, 0.10];
  const maxLevel = 10;

  if(current >= maxLevel) return '이미 최대 강화입니다.';

  const needGold = goldCosts[current];
  const successChance = chances[current];

  if(player.gold < needGold){
    return `골드가 부족합니다. (${needGold}G 필요)`;
  }

  player.gold -= needGold;

  // 성공
  if(Math.random() <= successChance){
    item.enhanceLevel += 1;

    if(item.type === 'weapon') item.atkBonus = (item.atkBonus || 0) + 3;
    if(item.type === 'armor') item.defBonus = (item.defBonus || 0) + 3;
    if(item.type === 'ring'){
      const p = pick(['critChanceBonus', 'critDamageBonus', 'dodgeBonus']);
      item[p] = (item[p] || 0) + 2;
    }

    return `🔨 ${item.name} 강화 성공! (+${item.enhanceLevel})`;
  }

  // 실패
  if(current >= 7){
    item.enhanceLevel -= 1;

    if(item.type === 'weapon') item.atkBonus = Math.max(0, (item.atkBonus || 0) - 3);
    if(item.type === 'armor') item.defBonus = Math.max(0, (item.defBonus || 0) - 3);
    if(item.type === 'ring'){
      const stats = ['critChanceBonus', 'critDamageBonus', 'dodgeBonus'];
      const candidates = stats.filter(k => (item[k] || 0) >= 2);

      if(candidates.length > 0){
        const p = pick(candidates);
        item[p] = Math.max(0, (item[p] || 0) - 2);
      }
    }

    return `❌ ${item.name} 강화 실패... (+${current} → +${item.enhanceLevel} 하락)`;
  }

  return `❌ ${item.name} 강화 실패...`;
}

function equipmentText(player){
  const weapon = player.equipment.weapon
    ? `${player.equipment.weapon.name}${getEnhanceLevelText(player.equipment.weapon)}${getItemStatText(player.equipment.weapon)}`
    : '없음';

  const armor = player.equipment.armor
    ? `${player.equipment.armor.name}${getEnhanceLevelText(player.equipment.armor)}${getItemStatText(player.equipment.armor)}`
    : '없음';

  const ring = player.equipment.ring
    ? `${player.equipment.ring.name}${getEnhanceLevelText(player.equipment.ring)}${getItemStatText(player.equipment.ring)}`
    : '없음';

  return [
    `⚔️ 무기: ${weapon}`,
    `🛡️ 갑옷: ${armor}`,
    `💍 반지: ${ring}`
  ].join('\n');
}
function materialsText(player){
  const rows = Object.entries(player.materials).filter(([,v])=>v>0).map(([k,v])=>`${k} ${v}`);
  return rows.length ? rows.join(' / ') : '없음';
}

const ITEMS_PER_PAGE = 5;

function getInventoryTotalPages(player){
  return Math.max(1, Math.ceil((player.inventory?.length || 0) / ITEMS_PER_PAGE));
}

function inventoryText(player, page = 1){
  if(!player.inventory.length) return '비어있음';

  const totalPages = getInventoryTotalPages(player);
  const safePage = Math.min(Math.max(page, 1), totalPages);

  const start = (safePage - 1) * ITEMS_PER_PAGE;
  const end = start + ITEMS_PER_PAGE;

  return player.inventory
    .slice(start, end)
    .map((it, idx) => `${start + idx + 1}. ${it.name} [${it.type}]`)
    .join('\n');
}

function buildFullStatusText(player){
  const eq = getEquippedBonuses(player);

  const baseAtk = player.baseAtk + player.stats.atk * 1;
  const totalAtk = baseAtk + eq.atk;

  const baseDef = player.baseDef + Math.floor(player.level / 3);
  const totalDef = baseDef + eq.def;

  const baseCrit = player.stats.critChance;
  const totalCrit = Math.min(STAT_CAPS.critChance, baseCrit + eq.critChance);

  const baseCritDmg = player.stats.critDamage;
  const totalCritDmg = Math.min(STAT_CAPS.critDamage, baseCritDmg + eq.critDamage);

  const baseDodge = player.stats.dodge;
  const totalDodge = Math.min(STAT_CAPS.dodge, baseDodge + eq.dodge);

const weaponText = player.equipment.weapon
  ? `${player.equipment.weapon.name} (공+${player.equipment.weapon.atkBonus || 0}, 방+${player.equipment.weapon.defBonus || 0}, 크리+${player.equipment.weapon.critChanceBonus || 0}%, 크뎀+${player.equipment.weapon.critDamageBonus || 0}%, 회피+${player.equipment.weapon.dodgeBonus || 0}%)`
  : '없음';

const armorText = player.equipment.armor
  ? `${player.equipment.armor.name} (공+${player.equipment.armor.atkBonus || 0}, 방+${player.equipment.armor.defBonus || 0}, 크리+${player.equipment.armor.critChanceBonus || 0}%, 크뎀+${player.equipment.armor.critDamageBonus || 0}%, 회피+${player.equipment.armor.dodgeBonus || 0}%)`
  : '없음';

const ringText = player.equipment.ring
  ? `${player.equipment.ring.name} (공+${player.equipment.ring.atkBonus || 0}, 방+${player.equipment.ring.defBonus || 0}, 크리+${player.equipment.ring.critChanceBonus || 0}%, 크뎀+${player.equipment.ring.critDamageBonus || 0}%, 회피+${player.equipment.ring.dodgeBonus || 0}%)`
  : '없음';

  return [
    `🏷️ 레벨: ${player.level} (${player.xp}/${player.nextXp})`,
    `🎯 스탯포인트: ${player.statPoints}`,
    `❤️ HP: ${player.hp}/${player.maxHp}`,
    `⚔️ 공격력: ${totalAtk} (${baseAtk} + 장비 ${eq.atk})`,
    `🛡️ 방어력: ${totalDef} (${baseDef} + 장비 ${eq.def})`,
    `💥 크리확률: ${totalCrit}% (${baseCrit}% + 장비 ${eq.critChance}%)`,
    `🔥 크리데미지: +${totalCritDmg}% (${baseCritDmg}% + 장비 ${eq.critDamage}%)`,
    `💨 회피: ${totalDodge}% (${baseDodge}% + 장비 ${eq.dodge}%)`,
    ``,
    `⚔️ 무기: ${weaponText}`,
    `🛡️ 갑옷: ${armorText}`,
    `💍 반지: ${ringText}`,
  ].join('\n');
}
function buildBagText(player){
  const mats = Object.entries(player.materials || {})
    .filter(([,v]) => v > 0)
    .map(([k,v]) => `${k} ${v}`)
    .join(' / ') || '없음';

const items = player.inventory && player.inventory.length
  ? player.inventory.slice(0,15).map((it,idx)=>
      `${idx+1}. ${it.name}${getItemStatText(it)} [${it.type}]`
    ).join('\n')
  : '비어있음';

  return [
    `💰 골드: ${player.gold}`,
    `💖 부활권: ${player.reviveTickets}`,
    `💎 속성석: ${Object.entries(player.stones || {}).map(([k,v])=>`${k}${v}`).join(' / ')}`,
    `📦 재료: ${mats}`,
    '',
    `🎒 인벤토리`,
    items,
  ].join('\n');
}

function buildCompactBattleText(player,target,channelId){
  const lines = [];
  if(target){
    lines.push(`👿 ${target.name}`);
    lines.push(`❤️ ${target.currentHp}/${target.hp}`);
    lines.push(`⚔️ ${target.atk} / 🛡️ ${target.def}`);
    lines.push(`✨ 속성: ${target.element}`);
    lines.push('━━━━━━━━━━');
  } else {
    lines.push('👿 몬스터 없음');
    lines.push('━━━━━━━━━━');
  }
  lines.push(`<#${channelId}>`);
  lines.push(`❤️ ${player.hp}/${player.maxHp}`);
  lines.push(`⚔️ ${getAttackPower(player)} / 🛡️ ${getDefensePower(player)}`);
  lines.push(`💊 ${player.potions.small} / 🍗 ${player.potions.mid} / 🍖 ${player.potions.big} / 🧪 ${player.potions.elixir}`);

  return lines.join('\n');
}

function getItemStatText(item){
  if(!item) return '';

  const atk = item.atkBonus || 0;
  const def = item.defBonus || 0;
  const crit = item.critChanceBonus || 0;
  const critDmg = item.critDamageBonus || 0;
  const dodge = item.dodgeBonus || 0;

  const parts = [];

  if(atk) parts.push(`공+${atk}`);
  if(def) parts.push(`방+${def}`);
  if(crit) parts.push(`크리+${crit}%`);
  if(critDmg) parts.push(`크뎀+${critDmg}%`);
  if(dodge) parts.push(`회피+${dodge}%`);

  return parts.length ? ` (${parts.join(', ')})` : '';
}



function buildTownButtons(player){
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('status').setLabel('📋 상태창').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('shop').setLabel('🏪 상점').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('craft_list').setLabel('🛠️ 제작').setStyle(ButtonStyle.Primary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('bag_view').setLabel('🎒 가방').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('enhance_view').setLabel('🔨 장비강화').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('equipment_view').setLabel('🧰 장비').setStyle(ButtonStyle.Primary),
    ),
  new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('attribute_enhance').setLabel('✨ 속성강화').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('attribute_remove').setLabel('🗑️ 속성삭제').setStyle(ButtonStyle.Danger),
   ),
  ];
}





function buildTownPayload(player, extraText=''){
  const embed = new EmbedBuilder()
    .setTitle('🏘️ 마을')
    .setDescription(
      [
        extraText,
        `💰 골드: ${player.gold}`,
        `🎟️ 부활권: ${player.reviveTickets}`,
        `🎒 인벤토리 확인 / 장비 / 제작 / 강화 / 상점을 이용할 수 있습니다.`,
      ].filter(Boolean).join('\n')
    )
    .setColor(0x2ecc71);

  return {
    embeds: [embed],
    components: buildTownButtons(player)
  };
}


function buildBattleButtons(player, dungeonKey){
  const canAuto = DUNGEONS[dungeonKey]?.autoAllowed || false;
  const down = !!player.run?.isDown;

  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('attack').setLabel('⚔️ 공격').setStyle(ButtonStyle.Danger).setDisabled(down),
      new ButtonBuilder().setCustomId('use_small').setLabel('💊').setStyle(ButtonStyle.Secondary).setDisabled(down),
      new ButtonBuilder().setCustomId('use_mid').setLabel('🍗').setStyle(ButtonStyle.Secondary).setDisabled(down),
      new ButtonBuilder().setCustomId('status').setLabel('📋 상태창').setStyle(ButtonStyle.Primary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('revive').setLabel('💖 부활권').setStyle(ButtonStyle.Success).setDisabled(!down || player.reviveTickets <= 0),     
      new ButtonBuilder().setCustomId('use_big').setLabel('🍖').setStyle(ButtonStyle.Secondary).setDisabled(down),
      new ButtonBuilder().setCustomId('use_elixir').setLabel('🧪').setStyle(ButtonStyle.Secondary).setDisabled(down),
      new ButtonBuilder().setCustomId('auto').setLabel(canAuto ? '🤖 자동' : '자동불가').setStyle(canAuto ? ButtonStyle.Success : ButtonStyle.Secondary).setDisabled(!canAuto || down),
      
    ),
  ];
}

function buildStatusButtons(player){
  const noPoints = player.statPoints <= 0;
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('stat_atk').setLabel('⚔️ 공격 +').setStyle(ButtonStyle.Danger).setDisabled(noPoints),
    new ButtonBuilder().setCustomId('stat_crit').setLabel('💥 크리 +').setStyle(ButtonStyle.Primary).setDisabled(noPoints || getCritChance(player)>=STAT_CAPS.critChance),
    new ButtonBuilder().setCustomId('stat_critdmg').setLabel('🔥 크뎀 +').setStyle(ButtonStyle.Primary).setDisabled(noPoints || getCritDamage(player)>=STAT_CAPS.critDamage),
    new ButtonBuilder().setCustomId('stat_dodge').setLabel('💨 회피 +').setStyle(ButtonStyle.Success).setDisabled(noPoints || getDodge(player)>=STAT_CAPS.dodge),
  )];
}
function buildShopButtons(){
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('buy_small').setLabel('💊 10G').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('buy_mid').setLabel('🍗 30G').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('buy_big').setLabel('🍖 100G').setStyle(ButtonStyle.Secondary),
  
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('buy_big_10').setLabel('🍖×10 (1000G)').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('buy_elixir').setLabel('🧪 3000G').setStyle(ButtonStyle.Secondary),
    )
  ];
}

function craftListText(player){
  return CRAFTS.map(c => {
    const mats = Object.entries(c.materials)
      .map(([m,n]) => `${m}${n}`)
      .join(' / ');
    return `- ${c.label} / ${mats} / ${canCraft(player,c) ? '제작가능' : '부족'}`;
  }).join('\n');
}

function craftListTextByType(player, type){
  const filtered = CRAFTS.filter(c => c.type === type);

  if(!filtered.length) return '제작식이 없습니다.';

  return filtered.map(c => {
    const mats = Object.entries(c.materials)
      .map(([m,n]) => `${m}${n}`)
      .join(' / ');
    return `- ${c.label} / ${mats} / ${canCraft(player,c) ? '제작가능' : '부족'}`;
  }).join('\n');
}

function buildCraftButtonsByType(type){
  const filtered = CRAFTS.filter(c => c.type === type);
  const rows = [];

  for(let i = 0; i < filtered.length; i += 4){
    rows.push(
      new ActionRowBuilder().addComponents(
        ...filtered.slice(i, i + 4).map(c =>
          new ButtonBuilder()
            .setCustomId(`craft_${c.id}`)
            .setLabel(c.label)
            .setStyle(ButtonStyle.Primary)
        )
      )
    );
  }

  return rows.slice(0, 5);
}

function getCraftIdByLabel(label){
  const f = CRAFTS.find(c => c.label === label);
  return f ? f.id : null;
}

function buildCraftCategoryButtons(){
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('craft_cat_weapon').setLabel('⚔️ 무기').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('craft_cat_armor').setLabel('🛡️ 갑옷').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('craft_cat_ring').setLabel('💍 반지').setStyle(ButtonStyle.Success),
    )
  ];
}



function shortItemName(name, max = 10){
  if(!name) return '장비';
  return name.length > max ? name.slice(0, max) + '…' : name;
}

function buildEquipmentButtons(player, page = 1){
  if(!player.inventory.length) return [];

  const totalPages = getInventoryTotalPages(player);
  const safePage = Math.min(Math.max(page, 1), totalPages);

  const start = (safePage - 1) * ITEMS_PER_PAGE;
  const end = start + ITEMS_PER_PAGE;
  const pageItems = player.inventory.slice(start, end);

  const rows = [];
  let currentRow = new ActionRowBuilder();
  let btnCount = 0;

  pageItems.forEach((item, idx) => {
    const absoluteIndex = start + idx;

    const equipBtn = new ButtonBuilder()
      .setCustomId(`equip_${absoluteIndex}`)
      .setLabel(`${absoluteIndex + 1}. ${shortItemName(item.name, 8)}`)
      .setStyle(ButtonStyle.Primary);

    const sellBtn = new ButtonBuilder()
      .setCustomId(`sell_${absoluteIndex}`)
      .setLabel('💰')
      .setStyle(ButtonStyle.Success);

    currentRow.addComponents(equipBtn, sellBtn);
    btnCount += 2;

    if(btnCount >= 4){
      rows.push(currentRow);
      currentRow = new ActionRowBuilder();
      btnCount = 0;
    }
  });

  if(currentRow.components.length > 0){
    rows.push(currentRow);
  }

  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`equipment_prev_${safePage}`)
        .setLabel('◀ 이전')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(safePage <= 1),

      new ButtonBuilder()
        .setCustomId(`equipment_page_${safePage}`)
        .setLabel(`${safePage}/${totalPages}`)
        .setStyle(ButtonStyle.Primary)
        .setDisabled(true),

      new ButtonBuilder()
        .setCustomId(`equipment_next_${safePage}`)
        .setLabel('다음 ▶')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(safePage >= totalPages)
    )
  );

  return rows.slice(0, 5);
}
function buildEnhanceItemButtons(player){
  const rows = [];

  if(player.equipment.weapon){
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('enhance_equipped_weapon')
          .setLabel(`⚔️ 착용 무기: ${player.equipment.weapon.name}`)
          .setStyle(ButtonStyle.Danger)
      )
    );
  }

  if(player.equipment.armor){
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('enhance_equipped_armor')
          .setLabel(`🛡️ 착용 갑옷: ${player.equipment.armor.name}`)
          .setStyle(ButtonStyle.Primary)
      )
    );
  }

  if(player.equipment.ring){
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('enhance_equipped_ring')
          .setLabel(`💍 착용 반지: ${player.equipment.ring.name}`)
          .setStyle(ButtonStyle.Success)
      )
    );
  }

  if(player.inventory.length){
    for(let i = 0; i < Math.min(12, player.inventory.length); i += 4){
      rows.push(
        new ActionRowBuilder().addComponents(
          ...player.inventory.slice(i, i + 4).map((item, idx) =>
            new ButtonBuilder()
              .setCustomId(`enhance_item_${i + idx}`)
              .setLabel(`${i + idx + 1}. ${item.name}`)
              .setStyle(ButtonStyle.Secondary)
          )
        )
      );
    }
  }

  return rows;
}

function buildIntroPayload(dungeonKey, target){
  if(!target){
    return { embeds:[new EmbedBuilder().setTitle('⚠️ 몬스터 없음').setDescription('현재 표시할 몬스터가 없습니다.').setColor(0x555555)] };
  }
  const embed = new EmbedBuilder()
    .setTitle(`👁️ ${target.name} 등장`)
    .setDescription(`던전: ${DISPLAY_NAMES[dungeonKey]}\n속성: ${target.element}\n\n`)
    .setColor(0x550000);
  const img = buildImageAttachment(target.name);
  if(img){
    embed.setImage(img.embedUrl);
    return { embeds:[embed], files:[img.attachment] };
  }
  return { embeds:[embed] };
}
function buildBattlePayload(player, channelId, dungeonKey, extraText=''){
  const target = player.run?.target || null;
  const embed = new EmbedBuilder()
    .setTitle(`⚔️ ${DISPLAY_NAMES[dungeonKey]}`)
    .setDescription([extraText, buildCompactBattleText(player,target,channelId)].filter(Boolean).join('\n\n'))
    .setColor(0xaa2222);
  let files = [];
  const img = target ? buildImageAttachment(target.name) : null;
  if(img){
    embed.setImage(img.embedUrl);
    files = [img.attachment];
  }
  if(player.run?.isDown){
    const death = getDeathAttachment();
    if(death){
      embed.setImage(death.embedUrl);
      files = [death.attachment];
    }
  }
  return { embeds:[embed], files, components:buildBattleButtons(player, dungeonKey) };
}

// =========================
// 4) 첫 이미지 잔상/드랍 잔상 수정용 함수들 교체
// =========================


async function spawnNextTargetByInteraction(interaction, player, dungeonKey){
  if(!player.run?.nextTarget){
    await interaction.followUp({ content:'다음 몬스터가 없습니다.', ephemeral:true });
    return;
  }

  player.run.lastDrops = [];

  player.run.target = player.run.nextTarget;
  player.run.nextTarget = null;
  await saveData(gameData);

  await interaction.message.edit(buildIntroPayload(dungeonKey, player.run.target));
  await sleep(INTRO_DELAY_MS);
  await interaction.message.edit(buildBattlePayload(player, interaction.channelId, dungeonKey, '전투 시작!'));
  }

  function formatHelp(){
    return [
      '`!시작` - 현재 채널 던전 시작',
      '`!상태` - 상태창',
      '`!가방` - 가방',
      '`!상점` - 상점',
      '`!제작목록` - 제작식 보기',
      '`!제작 슬라임검` - 제작',
      '`!장착 1` - 인벤토리 번호 장착',
      '`!자동` - 자동사냥',
      '`!초기화` - 데이터 초기화',
    ].join('\n');
  }

/* 상점 reply 문구 예시 */
'🏪 상점\n💊  작은물약 10G\n🍗 중간물약 30G\n🍖  큰물약 100G\n🧪 엘릭서 3000G'


client.once('ready', async () => {
  console.log(`${client.user.tag} 로그인 완료`);

if (!gameData) gameData = {};
});


client.on('messageCreate', async (message)=>{
console.log('메시지 받음:', message.content, message.channel.id);
  if(message.author.bot) return;
  if(!message.content.startsWith('!')) return;

  const parts = message.content.trim().split(/\s+/);
  const command = parts[0];
  const arg = parts[1];
  const player = getPlayer(message.author.id);

if(command === '!가방'){
    console.log("📦 !가방 분기 들어옴");
    await saveData(gameData);
    await message.reply({ content: buildBagText(player) });
    return;
}

  if(command === '!도움말'){
    await message.reply(formatHelp());
    return;
  }
  if(command === '!초기화'){
    gameData[message.author.id] = getDefaultPlayer(message.author.id);
await saveData(gameData);
    await message.reply('초기화 완료');
    return;
  }

  if(command === '!상태'){
    await saveData(gameData);
    await message.reply({ content:buildFullStatusText(player), components:buildStatusButtons(player) });
    return;
  }
   if(command === '!상점'){
  await message.reply({
    content:
`🏪 상점

💰 보유 골드: ${player.gold}

💊 작은물약 10G
🍗 중간물약 30G
🍖 큰물약 100G
🧪 엘릭서 3000G`,
    components: buildShopButtons()
  });
  return;
}
  
if(command === '!제작목록'){
  await message.reply({
    content: `🛠️ 제작 카테고리를 선택하세요.`,
    components: buildCraftCategoryButtons()
  });
  return;
}
  if(command === '!제작'){
    const craftId = getCraftIdByLabel(arg);
    if(!craftId){
      await message.reply('없는 제작식입니다.');
      return;
    }
    const res = tryCraft(player, craftId);
    await saveData(gameData);
    await message.reply(res.text);
    return;
  }
  if(command === '!장착'){
    const idx = Number(arg) - 1;
    if(Number.isNaN(idx)){ await message.reply('사용법: !장착 1'); return; }
    const text = equipItemByIndex(player, idx);
    await saveData(gameData);
    await message.reply(text);
    return;
  }
if(command === '!강화'){
  if(!arg || !ELEMENTS.includes(arg)){
    await message.reply(`사용법: !강화 ${ELEMENTS.join('|')}`);
    return;
  }

  const active = Object.entries(player.attributes)
    .filter(([,v]) => v > 0)
    .map(([k]) => k);

  const current = player.attributes[arg] || 0;

  if(current <= 0 && active.length >= 2){
    await message.reply('속성은 최대 2개까지만 강화할 수 있습니다.');
    return;
  }

  if(current >= ATTRIBUTE_MAX){
    await message.reply(`❌ ${arg} 속성은 최대 +${ATTRIBUTE_MAX}입니다.`);
    return;
  }

  if((player.stones[arg] || 0) < 1){
    await message.reply(`${arg}석이 부족합니다.`);
    return;
  }

  const needGold = ATTRIBUTE_GOLD_COSTS[current];
  const chance = ATTRIBUTE_CHANCES[current];

  if(player.gold < needGold){
    await message.reply(`❌ 골드가 부족합니다. (${needGold}G 필요)`);
    return;
  }

  player.stones[arg] -= 1;
  player.gold -= needGold;

  const success = Math.random() * 100 < chance;

  if(success){
    player.attributes[arg] = current + 1;
    await saveData(gameData);
    await message.reply(`💎 ${arg} 강화 성공! 현재 ${arg}+${player.attributes[arg]} / 최대 ${ATTRIBUTE_MAX} (성공률 ${chance}%)`);
    return;
  }

  await saveData(gameData);
  await message.reply(`❌ ${arg} 강화 실패... (${arg}석 1개, ${needGold}G 소모 / 성공률 ${chance}%)`);
  return;
}

if (command === '!전체속성초기화') {
  const ADMIN_ID = '너디스코드아이디';
  if (message.author.id !== ADMIN_ID) {
    await message.reply('❌ 관리자만 사용할 수 있습니다.');
    return;
  }

  const playerIds = Object.keys(data.players || {});
  let count = 0;

  for (const id of playerIds) {
    const p = getPlayer(id);

    p.attributes = {
      화염: 0,
      얼음: 0,
      번개: 0,
      자연: 0,
      어둠: 0
    };

    count++;
  }

  await saveData(data);

  await message.reply(`🧹 전체 유저 속성 초기화 완료 (${count}명)`);
  console.log(`[전체속성초기화 완료] ${count}명`);
  return;
}

if(command === '!속성확인'){
  await message.reply(JSON.stringify(player.attributes, null, 2));
}


if(command === '!자동'){

  if(Date.now() < player.respawnAt){
    const min = Math.ceil((player.respawnAt - Date.now()) / 60000);
    await message.reply(`💀 아직 사망 패널티 중입니다. 약 ${min}분 후 다시 사냥할 수 있습니다.`);
    return;
  }

  refreshAutoHuntCharges(player);

  if (player.autoHuntCharges <= 0) {
    const remainMs = getNextAutoHuntChargeRemain(player);
    const remainMin = Math.floor(remainMs / 60000);
    const remainSec = Math.floor((remainMs % 60000) / 1000);

    await message.reply(
      `자동사냥권이 없습니다.\n다음 충전까지 ${remainMin}분 ${remainSec}초 남았습니다.`
    );
    return;
  }

  player.autoHuntCharges -= 1;
  await saveData(gameData);

  if(!dungeonKey){
    await message.reply('이 명령어는 던전 채널에서만 가능합니다.');
    return;
  }

  if(!DUNGEONS[dungeonKey].autoAllowed){
    await message.reply('이 던전은 자동사냥이 불가능합니다.');
    return;
  }

  createRunIfNeeded(player, dungeonKey);
  await saveData(gameData);

  const introTarget = player.run?.target || player.run?.nextTarget;

  // 1) 먼저 등장 이미지
  const introMsg = await message.reply(
    buildIntroPayload(dungeonKey, introTarget)
  );

  // 2) 1초 대기
  await sleep(INTRO_DELAY_MS);

  const logs = ['🤖 자동사냥 시작'];
  let dropLines = null;

  for(let i = 0; i < AUTO_HUNT_TURNS; i++){
    if(!player.run) break;
    if(player.run.isDown) break;

    if(player.run.target && player.run.nextTarget){
      player.run.target = player.run.nextTarget;
      player.run.nextTarget = null;
      logs.push(`\n[${i+1}턴]\n👁️ ${player.run.target.name} 등장! (${player.run.target.element})`);
      continue;
    }

    const beforeGold = player.gold;
    const beforeXp = player.xp;

    const result = performAttack(player, dungeonKey);
    logs.push(`\n[${i+1}턴]\n${result.logs.join('\n')}`);

    const gainedGold = Math.max(0, player.gold - beforeGold);
    const gainedXp = Math.max(0, player.xp - beforeXp);

    const reducedGold = Math.floor(gainedGold * 0.8);
    const reducedXp = Math.floor(gainedXp * 0.8);

    player.gold = beforeGold + reducedGold;
    player.xp = beforeXp + reducedXp;

    if(player.run?.lastDrops?.length){
      dropLines = [...player.run.lastDrops];
    }

    logs.push(`💰 자동사냥 보상 적용: 골드 ${gainedGold} → ${reducedGold}, 경험치 ${gainedXp} → ${reducedXp}`);

    if(Date.now() < player.respawnAt) break;
  }

  await saveData(gameData);

  // 3) 전투 로그 UI로 전환
  await introMsg.edit(
    buildBattlePayload(
      player,
      message.channel.id,
      dungeonKey,
      logs.join('\n')
    )
  );

  if(dropLines){
    await introMsg.followUp({
      content: `🎁 드랍템\n${dropLines.join('\n')}`,
      ephemeral: true
    });
  }

  return;
}

const dungeonKey = getDungeonByChannel(message.channel.id);

if (command === '!시작') {
  
  if(Date.now() < player.respawnAt){
    const min = Math.ceil((player.respawnAt - Date.now()) / 60000);
    await message.reply(`💀 아직 사망 패널티 중입니다. 약 ${min}분 후 다시 사냥할 수 있습니다.`);
    return;
  }

  const isTown = message.channel.id === TOWN_CHANNEL_ID;


  const startKey = isTown ? 'town' : dungeonKey;

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`private_start_${message.author.id}_${startKey}`)
      .setLabel('🎮 개인 시작')
      .setStyle(ButtonStyle.Primary)
  );

  await message.reply({
    content: `<@${message.author.id}> 전용 시작 버튼입니다.`,
    components: [row]
  });
  return;
}
});



client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;

  const player = getPlayer(interaction.user.id);
  const id = interaction.customId;
  const dungeonKey = getDungeonByChannel(interaction.channelId);

const revived = reviveIfRespawnReady(player);
if(revived) await saveData(gameData);


  if (id.startsWith('sell_')) {
    const index = Number(id.replace('sell_', ''));
    const item = player.inventory[index];

    if (!item) {
      await interaction.reply({
        content: '❌ 해당 아이템이 없습니다.',
        ephemeral: true
      });
      return;
    }

    if (isEquippedItem(player, item)) {
      await interaction.reply({
        content: '❌ 장착 중인 아이템은 판매할 수 없습니다.',
        ephemeral: true
      });
      return;
    }

    const price = getItemSellPrice(item);
    const itemName = item.name;

    player.inventory.splice(index, 1);
    player.gold += price;

    await saveData(gameData);

    await interaction.reply({
      content: `💰 ${itemName} 판매 완료! (+${price} 골드)`,
      ephemeral: true
    });
    return;
  }

if ((id === 'attack' || id === 'auto') && Date.now() < player.respawnAt) {
  const min = Math.ceil((player.respawnAt - Date.now()) / 60000);
  await interaction.reply({
    content: `💀 아직 사망 패널티 중입니다. 약 ${min}분 후 다시 사냥할 수 있습니다.`,
    ephemeral: true
  });
  return;
}

if (id.startsWith('private_start_')) {
  const parts = interaction.customId.split('_');
  const ownerId = parts[2];
  const startKey = parts.slice(3).join('_');

  if (interaction.user.id !== ownerId) {
    await interaction.reply({
      content: '이 버튼은 만든 사람만 사용할 수 있습니다.',
      ephemeral: true
    });
    return;
  }

  if (startKey === 'town') {
    await interaction.reply({
      content: '🏘️ 마을입니다! 원하는 기능을 선택하세요.',
      ephemeral: true,
      components: buildTownButtons(player)
    });
    return;
  }

  createRunIfNeeded(player, startKey);
  player.run.lastDrops = [];
  await saveData(gameData);

  const introTarget = player.run?.target || player.run?.nextTarget;

  // 1) 먼저 이미지/등장 연출
  await interaction.reply({
    ...buildIntroPayload(startKey, introTarget),
    ephemeral: true
  });

  // 2) 1초 대기
  await sleep(INTRO_DELAY_MS);

  // 3) 전투 UI로 전환
  await interaction.editReply(
    buildBattlePayload(
      player,
      interaction.channelId,
      startKey,
      '전투 시작!'
    )
  );

  return;
}

  // 마을/던전 공통으로 열려야 하는 버튼들
if (id === 'status') {
  await saveData(gameData);
  await interaction.reply({
    content: buildFullStatusText(player),
    components: buildStatusButtons(player),
    ephemeral: true
  });

  await safeDeleteReply(interaction, 8000);
  return;
}

  if (id === 'bag_view') {
    await interaction.reply({
      content: buildBagText(player),
      ephemeral: true
    });
    return;
  }

if (id === 'attribute_enhance') {
  await interaction.reply({
    content:
`✨ 속성 강화

보유 속성석:
🔥 화염 ${player.stones.화염 || 0}
❄️ 얼음 ${player.stones.얼음 || 0}
⚡ 번개 ${player.stones.번개 || 0}
🌿 자연 ${player.stones.자연 || 0}
🌑 어둠 ${player.stones.어둠 || 0}

현재 속성:
🔥 ${player.attributes.화염 || 0}
❄️ ${player.attributes.얼음 || 0}
⚡ ${player.attributes.번개 || 0}
🌿 ${player.attributes.자연 || 0}
🌑 ${player.attributes.어둠 || 0}

속성은 최대 2개 / 속성당 최대 +${ATTRIBUTE_MAX}`,
    components: buildAttributeButtons(),
    ephemeral: true
  });
  return;
}



  if (id === 'shop') {
    await interaction.reply({
      content:
`🏪 상점

💰 보유 골드: ${player.gold}

💊 작은물약 10G
🍗 중간물약 30G
🍖 큰물약 100G
🍖 x 10 큰물약 1000G
🧪 엘릭서 3000G`,
      components: buildShopButtons(),
      ephemeral: true
    });
    return;
  }

if (id === 'craft_list') {
  await interaction.reply({
    content: `🛠️ 제작 카테고리를 선택하세요.`,
    components: buildCraftCategoryButtons(),
    ephemeral: true
  });
  return;
}
if (id === 'craft_cat_weapon') {
  await interaction.reply({
    content: `⚔️ 무기 제작목록\n${craftListTextByType(player, 'weapon')}`,
    components: buildCraftButtonsByType('weapon'),
    ephemeral: true
  });
  return;
}

if (id === 'craft_cat_armor') {
  await interaction.reply({
    content: `🛡️ 갑옷 제작목록\n${craftListTextByType(player, 'armor')}`,
    components: buildCraftButtonsByType('armor'),
    ephemeral: true
  });
  return;
}

if (id === 'craft_cat_ring') {
  await interaction.reply({
    content: `💍 반지 제작목록\n${craftListTextByType(player, 'ring')}`,
    components: buildCraftButtonsByType('ring'),
    ephemeral: true
  });
  return;
}


if (id === 'equipment_view') {
  await interaction.reply({
    content: `🧰 장비창\n\n${equipmentText(player)}\n\n🎒 인벤토리\n${inventoryText(player)}`,
    components: buildEquipmentButtons(player),
    ephemeral: true
  });
  return;
}

if (id.startsWith('equipment_prev_') || id.startsWith('equipment_next_')) {
  const parts = id.split('_');
  const action = parts[1]; // prev or next
  const currentPage = Number(parts[2]);

  const totalPages = getInventoryTotalPages(player);

  let nextPage = currentPage;
  if (action === 'prev') nextPage--;
  if (action === 'next') nextPage++;

  if (nextPage < 1) nextPage = 1;
  if (nextPage > totalPages) nextPage = totalPages;

  await interaction.update({
    content: `${equipmentText(player)}\n\n인벤토리 (${nextPage}/${totalPages})\n${inventoryText(player, nextPage)}`,
    components: buildEquipmentButtons(player, nextPage)
  });
  return;
}

if (id === 'buy_big_10') {
  const cost = 1000;

  if (player.gold < cost) {
    await interaction.reply({
      content: '❌ 골드가 부족합니다. (큰물약 10개 1000G)',
      ephemeral: true
    });
    return;
  }

  player.gold -= cost;
  player.potions.big = (player.potions.big || 0) + 10;

  await saveData(gameData);

  await interaction.reply({
    content:
`✅ 큰물약 10개 구매 완료!

💰 남은 골드: ${player.gold}
🧪 보유 물약:
💊 ${player.potions.small || 0} / 🍗 ${player.potions.mid || 0} / 🍖 ${player.potions.big || 0} / 🧪 ${player.potions.elixir || 0}`,
    ephemeral: true
  });
  return;
}

if (id === 'buy_small' || id === 'buy_mid' || id === 'buy_big' || id === 'buy_elixir') {
  const shopMap = {
    buy_small: { key: 'small', name: '작은물약', price: 10 },
    buy_mid: { key: 'mid', name: '중간물약', price: 30 },
    buy_big: { key: 'big', name: '큰물약', price: 100 },
    buy_elixir: { key: 'elixir', name: '엘릭서', price: 3000 },
  };

  const buy = shopMap[id];

  if (!buy) {
    await interaction.reply({
      content: '구매할 수 없는 아이템입니다.',
      ephemeral: true
    });
    return;
  }

  if (player.gold < buy.price) {
    await interaction.reply({
      content: `❌ 골드가 부족합니다. (${buy.name} ${buy.price}G)`,
      ephemeral: true
    });
    return;
  }

  player.gold -= buy.price;
  player.potions[buy.key] = (player.potions[buy.key] || 0) + 1;

  await saveData(gameData);

  await interaction.reply({
    content:
`✅ ${buy.name} 1개 구매 완료!

💰 남은 골드: ${player.gold}
🧪 보유 물약:
💊 ${player.potions.small || 0} / 🍗 ${player.potions.mid || 0} / 🍖 ${player.potions.big || 0} / 🧪 ${player.potions.elixir || 0}`,
    ephemeral: true
  });
  return;
}





if (id.startsWith('equipment_prev_') || id.startsWith('equipment_next_')) {
  const page = 1;
  const totalPages = getInventoryTotalPages(player);

  await interaction.reply({
    content: `${equipmentText(player)}\n\n인벤토리 (${page}/${totalPages})\n${inventoryText(player, page)}`,
    components: buildEquipmentButtons(player, page),
    ephemeral: true
  });
  return;
}





if (id === 'enhance_view') {
  player.selectedEnhanceTarget = null;
  await saveData(gameData);
  await interaction.reply({
    content: `🔨 강화할 아이템을 선택하세요.\n\n${inventoryText(player)}\n\n강화는 골드만 소모됩니다.`,
    components: buildEnhanceItemButtons(player),
    ephemeral: true
  });
  return;
}

if (id.startsWith('enhance_item_')) {
  const idx = Number(id.replace('enhance_item_', ''));
  const item = player.inventory[idx];

  if (!item) {
    await interaction.reply({
      content: '선택한 아이템이 없습니다.',
      ephemeral: true
    });
    return;
  }

  const text = tryEnhanceItem(player, item);
  await saveData(gameData);

  await interaction.reply({
    content: `${text}\n\n${getEnhancePreviewText(player, item)}`,
    ephemeral: true
  });
  return;
}

if (id === 'enhance_equipped_weapon') {
  const item = player.equipment.weapon;

  if (!item) {
    await interaction.reply({
      content: '착용 무기가 없습니다.',
      ephemeral: true
    });
    return;
  }

  const text = tryEnhanceItem(player, item);
  await saveData(gameData);

  await interaction.reply({
    content: `${text}\n\n${getEnhancePreviewText(player, item)}`,
    ephemeral: true
  });
  return;
}

if (id === 'enhance_equipped_armor') {
  const item = player.equipment.armor;

  if (!item) {
    await interaction.reply({
      content: '착용 갑옷이 없습니다.',
      ephemeral: true
    });
    return;
  }

  const text = tryEnhanceItem(player, item);
  await saveData(gameData);

  await interaction.reply({
    content: `${text}\n\n${getEnhancePreviewText(player, item)}`,
    ephemeral: true
  });
  return;
}

if (id === 'enhance_equipped_ring') {
  const item = player.equipment.ring;

  if (!item) {
    await interaction.reply({
      content: '착용 반지가 없습니다.',
      ephemeral: true
    });
    return;
  }

  const text = tryEnhanceItem(player, item);
  await saveData(gameData);

  await interaction.reply({
    content: `${text}\n\n${getEnhancePreviewText(player, item)}`,
    ephemeral: true
  });
  return;
}

if (id.startsWith('craft_') && id !== 'craft_list' && !id.startsWith('craft_cat_')) {
  const craftId = id.replace('craft_', '');
  const res = tryCraft(player, craftId);
  await saveData(gameData);
  await interaction.reply({
    content: res.text,
    ephemeral: true
  });
  return;
}

if (id.startsWith('equip_')) {
  const idx = Number(id.replace('equip_', ''));
  const text = equipItemByIndex(player, idx);
  await saveData(gameData);
  await interaction.reply({
    content: `${text}\n\n${equipmentText(player)}`,
    ephemeral: true
  });
  return;
}

if (id === 'stat_atk' || id === 'stat_crit' || id === 'stat_critdmg' || id === 'stat_dodge') {
  const map = {
    stat_atk: 'atk',
    stat_crit: 'critChance',
    stat_critdmg: 'critDamage',
    stat_dodge: 'dodge'
  };

  const text = tryUpgradeStat(player, map[id]);
  await saveData(gameData);

  await interaction.reply({
    content: `${text}\n\n${buildFullStatusText(player)}`,
    components: buildStatusButtons(player),
    ephemeral: true
  });
  return;
}

// 던전 전용 버튼만 여기서 막기
const dungeonOnlyButtons = [
  'attack',
  'revive',
  'auto',
  'use_small',
  'use_mid',
  'use_big',
  'use_elixir'
];

const isDungeonOnlyButton = dungeonOnlyButtons.includes(id);

if (isDungeonOnlyButton && !dungeonKey) {
  await interaction.reply({
    content: '이 버튼은 던전 채널에서만 사용할 수 있습니다.',
    ephemeral: true
  });
  return;
}

if (id === 'revive') {
  if (!player.run?.isDown) {
    await interaction.reply({
      content: '지금은 부활권을 사용할 수 없습니다.',
      ephemeral: true
    });
    await safeDeleteReply(interaction, 3000);
    return;
  }

  if (player.reviveTickets <= 0) {
    await interaction.reply({
      content: '부활권이 없습니다.',
      ephemeral: true
    });
    await safeDeleteReply(interaction, 3000);
    return;
  }

  player.reviveTickets -= 1;
  player.hp = Math.max(1, Math.floor(player.maxHp));
  player.run.isDown = false;
  player.respawnAt = 0;

  await saveData(gameData);

  await interaction.update(
    buildBattlePayload(
      player,
      interaction.channelId,
      player.run.dungeon,
      '💖 부활권 사용! 부활했습니다.'
    )
  );
  return;
}

if (id.startsWith('attr_')) {
  const map = {
    attr_fire: '화염',
    attr_ice: '얼음',
    attr_lightning: '번개',
    attr_nature: '자연',
    attr_dark: '어둠'
  };

  const key = map[id];
  if (!key) return;

  const active = Object.entries(player.attributes)
    .filter(([,v]) => v > 0)
    .map(([k]) => k);

  const current = player.attributes[key] || 0;

  if(current <= 0 && active.length >= 2){
    await interaction.reply({
      content: '속성은 최대 2개까지만 강화할 수 있습니다.',
      ephemeral: true
    });
    return;
  }

  if(current >= ATTRIBUTE_MAX){
    await interaction.reply({
      content: `❌ ${key} 속성은 최대 +${ATTRIBUTE_MAX}입니다.`,
      ephemeral: true
    });
    return;
  }

  if((player.stones[key] || 0) <= 0){
    await interaction.reply({
      content: `❌ ${key} 속성석이 부족합니다.`,
      ephemeral: true
    });
    return;
  }

  const needGold = ATTRIBUTE_GOLD_COSTS[current];
  const chance = ATTRIBUTE_CHANCES[current];

  if(player.gold < needGold){
    await interaction.reply({
      content: `❌ 골드가 부족합니다. (${needGold}G 필요)`,
      ephemeral: true
    });
    return;
  }

  player.stones[key] -= 1;
  player.gold -= needGold;

  const success = Math.random() * 100 < chance;

  if(success){
    player.attributes[key] = current + 1;
    await saveData(gameData);

    await interaction.reply({
      content:
`✨ ${key} 속성 강화 성공!

현재 속성:
🔥 ${player.attributes.화염 || 0}
❄️ ${player.attributes.얼음 || 0}
⚡ ${player.attributes.번개 || 0}
🌿 ${player.attributes.자연 || 0}
🌑 ${player.attributes.어둠 || 0}

(소모: ${key}석 1개, ${needGold}G / 성공률: ${chance}%)`,
      ephemeral: true
    });
    return;
  }



  await saveData(gameData);

  await interaction.reply({
    content: `❌ ${key} 속성 강화 실패... (소모: ${key}석 1개, ${needGold}G / 성공률: ${chance}%)`,
    ephemeral: true
  });
  return;
}

 
if (id === 'attribute_remove') {
  const total = Object.values(player.attributes || {}).reduce((a, c) => a + c, 0);

  if(total <= 0){
    await interaction.reply({
      content: '삭제할 속성이 없습니다.',
      ephemeral: true
    });
    return;
  }

  await interaction.reply({
    content: `🗑️ 삭제할 속성을 선택하세요.\n비용: ${ATTRIBUTE_REMOVE_COST}G`,
    components: buildAttributeRemoveButtons(player),
    ephemeral: true
  });
  return;
}


if (id.startsWith('attr_remove_')) {
  const key = id.replace('attr_remove_', '');

  if((player.attributes[key] || 0) <= 0){
    await interaction.reply({
      content: '해당 속성이 없습니다.',
      ephemeral: true
    });
    return;
  }

  if(player.gold < ATTRIBUTE_REMOVE_COST){
    await interaction.reply({
      content: `❌ 골드가 부족합니다. (${ATTRIBUTE_REMOVE_COST}G 필요)`,
      ephemeral: true
    });
    return;
  }

  player.gold -= ATTRIBUTE_REMOVE_COST;
  player.attributes[key] = 0;

  await saveData(gameData);

  await interaction.reply({
    content: `🗑️ ${key} 속성 삭제 완료! (-${ATTRIBUTE_REMOVE_COST}G)`,
    ephemeral: true
  });
  return;
}



if (id.startsWith('use_')) {
  const key = id.replace('use_', '');

  if (player.run?.target && dungeonKey) {
    const result = usePotionInBattle(player, key);
    await saveData(gameData);

    await interaction.update(
      buildBattlePayload(player, interaction.channelId, dungeonKey, result.logs.join('\n'))
    );
    return;
  }

  const text = usePotionOutOfBattle(player, key);
  await saveData(gameData);

  await interaction.reply({
    content: text,
    ephemeral: true
  });
  await safeDeleteReply(interaction, 3000);
  return;
}

if (id === 'auto') {
  if (!DUNGEONS[dungeonKey]?.autoAllowed) {
    await interaction.reply({
      content: '이 던전은 자동사냥이 불가능합니다.',
      ephemeral: true
    });
    await safeDeleteReply(interaction, 3000);
    return;
  }

  refreshAutoHuntCharges(player);

  if (player.autoHuntCharges <= 0) {
    const remainMs = getNextAutoHuntChargeRemain(player);
    const remainMin = Math.floor(remainMs / 60000);
    const remainSec = Math.floor((remainMs % 60000) / 1000);

    await interaction.reply({
      content: `❌ 자동사냥권이 없습니다.\n다음 충전까지 ${remainMin}분 ${remainSec}초 남았습니다.`,
      ephemeral: true
    });
    await safeDeleteReply(interaction, 4000);
    return;
  }

  player.autoHuntCharges -= 1;
  createRunIfNeeded(player, dungeonKey);
  await saveData(gameData);

  const introTarget = player.run?.target || player.run?.nextTarget;

  // =========================
  // 1) 이미지 먼저 출력
  // =========================
  await interaction.update(
    buildIntroPayload(dungeonKey, introTarget)
  );

  // =========================
  // 2) 1초 대기
  // =========================
  await sleep(INTRO_DELAY_MS);

  const logs = [`🤖 자동사냥 시작 (남은 자동사냥권: ${player.autoHuntCharges}/${AUTO_HUNT_MAX_CHARGES})`];

  // =========================
  // 3) 자동 전투 루프
  // =========================
  for (let i = 0; i < AUTO_HUNT_TURNS; i++) {
    if (!player.run) break;
    if (player.run.isDown) break;

    if (player.run.target && player.run.nextTarget) {
      player.run.lastDrops = [];
      player.run.target = player.run.nextTarget;
      player.run.nextTarget = null;

      logs.push(`\n[${i + 1}턴]\n👁️ ${player.run.target.name} 등장! (${player.run.target.element})`);
      continue;
    }

    const beforeGold = player.gold;
    const beforeXp = player.xp;

    const result = performAttack(player, dungeonKey);

    const gainedGold = Math.max(0, player.gold - beforeGold);
    const gainedXp = Math.max(0, player.xp - beforeXp);

    const reducedGold = Math.floor(gainedGold * 0.8);
    const reducedXp = Math.floor(gainedXp * 0.8);

    player.gold = beforeGold + reducedGold;
    player.xp = beforeXp + reducedXp;

    if (player.run?.lastDrops) {
      player.run.lastDrops = player.run.lastDrops.filter(() => Math.random() < 0.8);
    }

    logs.push(`\n[${i + 1}턴]\n${result.logs.join('\n')}`);
    logs.push(`💰 자동사냥 보상 적용: 골드 ${gainedGold} → ${reducedGold}, 경험치 ${gainedXp} → ${reducedXp}`);

    if (Date.now() < player.respawnAt) break;
  }

  await saveData(gameData);

  // =========================
  // 4) 전투 로그 UI 출력
  // =========================
  await interaction.editReply(
    buildBattlePayload(
      player,
      interaction.channelId,
      dungeonKey,
      logs.join('\n')
    )
  );

  return;
}

if (id === 'attack') {
  if (!player.run) createRunIfNeeded(player, dungeonKey);

  if (!player.run.target && player.run.nextTarget) {
    player.run.lastDrops = [];
    player.run.target = player.run.nextTarget;
    player.run.nextTarget = null;
    await saveData(gameData);

    await interaction.update(
      buildIntroPayload(dungeonKey, player.run.target)
    );

    await sleep(INTRO_DELAY_MS);

    await interaction.editReply(
      buildBattlePayload(player, interaction.channelId, dungeonKey, '전투 시작!')
    );
    return;
  }

  const logs = [];

  for (let i = 0; i < 3; i++) {
    if (!player.run) break;
    if (player.run.isDown) break;

    logs.push(`\n⚔️ [${i + 1}턴]`);

    const result = performAttack(player, dungeonKey);

    logs.push(...result.logs);

    // 죽으면 중단
    if (Date.now() < player.respawnAt) break;

    // 몬스터 죽고 다음 몹 대기면 멈춤
    if (!player.run?.target && player.run?.nextTarget) break;
  }

  await saveData(gameData);

  await interaction.update(
    buildBattlePayload(player, interaction.channelId, dungeonKey, logs.join('\n'))
  );
  return;
}
});


require('dotenv').config();

console.log('MODE =', MODE);
console.log('DATA_FILE_PROD =', process.env.DATA_FILE_PROD);
console.log('DATA_FILE_TEST =', process.env.DATA_FILE_TEST);



const TOKEN = MODE === 'prod'
  ? (process.env.DISCORD_TOKEN_PROD || process.env.DISCORD_TOKEN)
  : (process.env.DISCORD_TOKEN_TEST || process.env.DISCORD_TOKEN);



console.log("MODE:", MODE);
console.log("TOKEN EXISTS:", !!TOKEN);
console.log("TOKEN LENGTH:", TOKEN ? TOKEN.length : 0);



client.login(TOKEN);