
require('dotenv').config();

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
const path = require('path');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

const DATA_FILE = path.join(__dirname, 'data_rpg_girin.json');
const IMAGE_PATH = path.join(__dirname, 'images');
const INTRO_DELAY_MS = 1000;
const TEMP_DROP_DELETE_MS = 5000;
const TOWN_CHANNEL_ID = '1487955862940024862';

const DUNGEON_CHANNELS = {
  '1487952892852965426': '초심자의숲',
  '1487952924092010667': '오색룡의둥지',
  '1487953115024982076': '지옥의관문',
  '1487953176677060780': '지옥의심장부',
  '1487953322160816148': '지옥의왕좌',
};

const DISPLAY_NAMES = {
  '초심자의숲': '초심자의 숲',
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
  '좀비드래곤의 피', '메탈조각', '좀비드래곤의 가죽', '빛의 조각'
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
  { id:'metal_sword', label:'장군넴소드', type:'weapon', materials:{ '낡은장비조각':8, '메탈조각':10 }, base:{atk:38,def:0} },
  { id:'metal_armor', label:'장군넴아머', type:'armor', materials:{ '낡은장비조각':8, '메탈조각':10 }, base:{atk:0,def:38} },
  { id:'bald_armor', label:'대머리갑옷', type:'armor', materials:{ '낡은장비조각':9, '좀비드래곤의 가죽':10 }, base:{atk:0,def:43} },
  { id:'light_sword', label:'빛의검', type:'weapon', materials:{ '낡은장비조각':10, '빛의 조각':10 }, base:{atk:45,def:0} },

{ id:'butcher_axe', label:'도살자의도끼', type:'weapon', materials:{ '고급장비조각':10, '도살자의 도끼조각':15 }, base:{atk:52,def:0} },
{ id:'leoric_armor', label:'레오릭왕의갑옷', type:'armor', materials:{ '고급장비조각':15, '레오릭왕의 뼈조각':15 }, base:{atk:0,def:55} },
{ id:'demon_cloak', label:'악마의망토', type:'armor', materials:{ '고급장비조각':20, '악마의 정수':20 }, base:{atk:0,def:68} },
{ id:'demon_sword', label:'악마의검', type:'weapon', materials:{ '고급장비조각':20, '악마의 정수':20 }, base:{atk:70,def:0} },
{ id:'lilith_ring', label:'릴리트의 반지', type:'ring', materials:{ '릴리트의 뿔':20 }, ringRandom:true, base:{atk:0,def:0} },
{ id:'end_sword', label:'종말의검', type:'weapon', materials:{ '디아블로의 뿔':20 }, base:{atk:88,def:0} },



];

const CRAFT_BY_ID = Object.fromEntries(CRAFTS.map(v => [v.id, v]));

const DUNGEONS = {
  '초심자의숲': { type: 'random', autoAllowed: true, monsters: [
    { name: '슬라임', hp: 22, atk: 6, def: 0, gold: [5,10], xp: 8 },
    { name: '늑대', hp: 28, atk: 8, def: 0, gold: [8,14], xp: 10 },
    { name: '고블린', hp: 34, atk: 10, def: 1, gold: [10,16], xp: 12 },
    { name: '오크', hp: 52, atk: 14, def: 2, gold: [16,24], xp: 16 },
    { name: '오우거', hp: 82, atk: 18, def: 3, gold: [25,40], xp: 24 },
    { name: '드래곤', hp: 145, atk: 24, def: 5, gold: [50,80], xp: 45 },
  ]},
  '오색룡의둥지': { type: 'random', autoAllowed: true, monsters: [
    { name: '번개드래곤', hp: 105, atk: 19, def: 4, gold: [35,55], xp: 35 },
    { name: '얼음드래곤', hp: 110, atk: 20, def: 4, gold: [35,58], xp: 36 },
    { name: '붉은화염드래곤', hp: 118, atk: 22, def: 5, gold: [40,62], xp: 38 },
    { name: '푸른화염드래곤', hp: 124, atk: 23, def: 5, gold: [42,66], xp: 40 },
    { name: '어둠드래곤', hp: 130, atk: 24, def: 6, gold: [45,70], xp: 42 },
    { name: '좀비드래곤', hp: 155, atk: 27, def: 7, gold: [60,90], xp: 52 },
    { name: '메탈드래곤', hp: 185, atk: 31, def: 8, gold: [85,120], xp: 65 },
    { name: '대독드래곤', hp: 195, atk: 33, def: 9, gold: [90,130], xp: 70 },
    { name: '빛의 군주 드래곤', hp: 215, atk: 36, def: 10, gold: [100,150], xp: 80 },
  ]},
  '지옥의관문': { type: 'wave', autoAllowed: false, waves: [
    { name: '도살자', hp: 350, atk: 40, def: 6, gold: [70,100], xp: 60 },
    { name: '레오릭 왕', hp: 400, atk: 42, def: 7, gold: [85,115], xp: 70 },
    { name: '두리엘', hp: 450, atk: 44, def: 8, gold: [100,135], xp: 84 },
    { name: '안다리엘', hp: 500, atk: 46, def: 8, gold: [110,145], xp: 88 },
    { name: '벨리알', hp: 550, atk: 48, def: 9, gold: [125,165], xp: 96 },
    { name: '아즈모단', hp: 600, atk: 50, def: 10, gold: [135,180], xp: 105 },
    { name: '릴리트', hp: 800, atk: 55, def: 11, gold: [180,230], xp: 120 },
    { name: '바알', hp: 1000, atk: 60, def: 12, gold: [200,250], xp: 130 },
    { name: '메피스토', hp: 1200, atk: 65, def: 13, gold: [220,270], xp: 140 },
    { name: '디아블로', hp: 1500, atk: 70, def: 14, gold: [250,300], xp: 150 },
    { name: '종말의 화신 디아블로', hp: 2000, atk: 80, def: 18, gold: [400,520], xp: 220 },
  ]},
  '지옥의심장부': { type: 'wave', autoAllowed: false, waves: [
    { name: '우버 레오릭 왕', hp: 2200, atk: 85, def: 11, gold: [180,230], xp: 120 },
    { name: '우버 안다리엘', hp: 2300, atk: 87, def: 12, gold: [220,280], xp: 135 },
    { name: '우버 두리엘', hp: 2400, atk: 90, def: 13, gold: [250,310], xp: 145 },
    { name: '우버 바알', hp: 2500, atk: 92, def: 15, gold: [320,390], xp: 165 },
    { name: '우버 디아블로', hp: 2600, atk: 94, def: 16, gold: [350,420], xp: 175 },
    { name: '우버 메피스토', hp: 2700, atk: 96, def: 17, gold: [370,450], xp: 182 },
    { name: '우버 릴리트', hp: 2800, atk: 98, def: 18, gold: [400,490], xp: 190 },
    { name: '우버 종말의 화신 디아블로', hp: 3500, atk: 110, def: 21, gold: [650,800], xp: 260 },
  ]},
  '지옥의왕좌': { type: 'wave', autoAllowed: false, waves: [
    { name: '증오의 군주 디아블로', hp: 4000, atk: 120, def: 23, gold: [500,620], xp: 220 },
    { name: '파괴의 군주 디아블로', hp: 6000, atk: 150, def: 25, gold: [560,700], xp: 240 },
    { name: '만악의 군주 디아블로', hp: 8000, atk: 200, def: 27, gold: [700,900], xp: 300 },
  ]},
};

function rand(min,max){ return Math.floor(Math.random()*(max-min+1))+min; }
function chance(percent){ return Math.random()*100 < percent; }
function pick(arr){ return arr[Math.floor(Math.random()*arr.length)]; }
function sleep(ms){ return new Promise(resolve => setTimeout(resolve, ms)); }
function round1(v){ return Math.round(v*10)/10; }

function loadData(){
  if(!fs.existsSync(DATA_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(DATA_FILE,'utf8')); }
  catch(e){ console.error('데이터 로드 실패', e); return {}; }
}
function saveData(data){
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}
let db = loadData();

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
    level:1, xp:0, nextXp:50, statPoints:0,
    maxHp:100, hp:100, baseAtk:12, baseDef:3,
    gold:100, reviveTickets:0, respawnAt:0,
    stones:{ 화염:0, 얼음:0, 번개:0, 자연:0, 어둠:0 },
    attributes:{},
    potions:{ small:2, mid:1, big:0, elixir:0 },
    materials: blankMaterials(),
    inventory: [],
    equipment: defaultEquipment(),
    stats:{ atk:0, critChance:0, critDamage:0, dodge:0 },
    run:null,
    selectedEnhanceIndex:null,
  };
}
function getPlayer(userId){
  if(!db[userId]) db[userId] = getDefaultPlayer(userId);
  return db[userId];
}
function getDungeonByChannel(channelId){
  return DUNGEON_CHANNELS[channelId] || null;
}
function getRandomMonster(dungeonKey) {
  let base;

  // =========================
  // 초심자의 숲 확률
  // =========================
  if (dungeonKey === '초심자의숲') {
    const roll = Math.random() * 100;

    if (roll < 40) {
      base = DUNGEONS[dungeonKey].monsters.find(m => m.name === '슬라임');
    } else if (roll < 70) {
      base = DUNGEONS[dungeonKey].monsters.find(m => m.name === '늑대');
    } else if (roll < 82) {
      base = DUNGEONS[dungeonKey].monsters.find(m => m.name === '고블린');
    } else if (roll < 92) {
      base = DUNGEONS[dungeonKey].monsters.find(m => m.name === '오크');
    } else if (roll < 97) {
      base = DUNGEONS[dungeonKey].monsters.find(m => m.name === '오우거');
    } else {
      base = DUNGEONS[dungeonKey].monsters.find(m => m.name === '드래곤');
    }
  }

  // =========================
  // 오색룡의 둥지 확률
  // =========================
  else if (dungeonKey === '오색룡의둥지') {
    const roll = Math.random() * 100;

    if (roll < 25) {
      base = DUNGEONS[dungeonKey].monsters.find(m => m.name === '좀비드래곤');
    } else if (roll < 29) {
      base = DUNGEONS[dungeonKey].monsters.find(m => m.name === '메탈드래곤');
    } else if (roll < 33) {
      base = DUNGEONS[dungeonKey].monsters.find(m => m.name === '대독드래곤');
    } else if (roll < 36) {
      base = DUNGEONS[dungeonKey].monsters.find(m => m.name === '빛의 군주 드래곤');
    } else {
      // 나머지 64% → 오색룡 5종 랜덤
      const dragons = [
        '번개드래곤',
        '얼음드래곤',
        '붉은화염드래곤',
        '푸른화염드래곤',
        '어둠드래곤'
      ];
      const pickName = dragons[Math.floor(Math.random() * dragons.length)];
      base = DUNGEONS[dungeonKey].monsters.find(m => m.name === pickName);
    }
  }

  // =========================
  // 나머지 던전
  // =========================
  else {
    base = pick(DUNGEONS[dungeonKey].monsters);
  }

  return {
    ...base,
    currentHp: base.hp,
    element: pick(ELEMENTS),
  };



}
function getWaveMonster(dungeonKey, idx){
  const base = DUNGEONS[dungeonKey].waves[idx];
  if(!base) return null;
  return { ...base, currentHp:base.hp, element:pick(ELEMENTS) };
}

function isAllowedCategory(channel){
  if(ALLOWED_CATEGORY_IDS.length === 0) return true; // 비어있으면 제한 없음
  return ALLOWED_CATEGORY_IDS.includes(channel.parentId);
}

function createRunIfNeeded(player, dungeonKey){
  if(player.run && player.run.dungeon === dungeonKey) return;
  const d = DUNGEONS[dungeonKey];
  player.run = {
    dungeon:dungeonKey,
    waveIndex:0,
    kills:0,
    target:d.type === 'random' ? getRandomMonster(dungeonKey) : getWaveMonster(dungeonKey, 0),
    nextTarget:null,
    isDown:false,
    lastDrops:[],
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
    case '슬라임': if(chance(70)) drops.push(['슬라임젤리',1]); break;
    case '늑대': if(chance(60)) drops.push(['늑대가죽',1]); break;
    case '고블린': if(chance(60)) drops.push(['고블린뼈조각',1]); break;
    case '오우거': if(chance(50)) drops.push(['오우거가죽',1]); break;
    case '드래곤': if(chance(30)) drops.push(['작은 용비늘',1]); break;
  }

  const dragonSet = ['번개드래곤','얼음드래곤','붉은화염드래곤','푸른화염드래곤','어둠드래곤','좀비드래곤','메탈드래곤','대독드래곤','빛의 군주 드래곤'];
  if(dragonSet.includes(monsterName)){
    if(chance(60)) drops.push(['드래곤 비늘',1]);
    if(chance(60)) drops.push(['드래곤 발톱',1]);
    if(chance(40)) drops.push(['낡은장비조각',1]);
  }

  switch(monsterName){
    case '번개드래곤': drops.push(['번개조각',1]); break;
    case '얼음드래곤': drops.push(['얼음조각',1]); break;
    case '붉은화염드래곤': drops.push(['붉은화염조각',1]); break;
    case '푸른화염드래곤': drops.push(['푸른화염조각',1]); break;
    case '어둠드래곤': drops.push(['어둠조각',1]); break;
    case '좀비드래곤': if(chance(50)) drops.push(['좀비드래곤의 피',1]); break;
    case '메탈드래곤': if(chance(40)) drops.push(['메탈조각',1]); break;
    case '대독드래곤': if(chance(40)) drops.push(['좀비드래곤의 가죽',1]); break;
    case '빛의 군주 드래곤': if(chance(40)) drops.push(['빛의 조각',1]); break;
  }

 const hellGate = ['도살자','레오릭 왕','두리엘','안다리엘','벨리알','아즈모단','릴리트','바알','메피스토','디아블로','종말의 화신 디아블로'];
  if(hellGate.includes(monsterName) && chance(40)) drops.push(['고급장비조각',1]);

  if(monsterName === '도살자' && chance(60)) drops.push(['도살자의 도끼조각',1]);
  if(monsterName === '레오릭 왕' && chance(60)) drops.push(['레오릭왕의 뼈조각',1]);
  if(['두리엘','안다리엘','벨리알','아즈모단'].includes(monsterName) && chance(50)) drops.push(['악마의 살점',1]);
  if(monsterName === '릴리트' && chance(40)) drops.push(['릴리트의 뿔',1]);
  if(['바알','메피스토','디아블로'].includes(monsterName) && chance(40)) drops.push(['악마의 정수',1]);
  if(monsterName === '종말의 화신 디아블로' && chance(40)) drops.push(['디아블로의 뿔',1]);

  return drops;
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

  if(chance(20)){
    player.stones[monster.element] += 1;
    lines.push(`💎 ${monster.element}석 +1`);
  }

  for(const [name, amount] of getMaterialDrops(monster.name)){
    grantMaterial(player, name, amount, lines);
  }

  let reviveChance = 0.3;
  if(monster.name.includes('드래곤')) reviveChance = 0.8;
  if(monster.name.includes('우버')) reviveChance = 2.5;
  if(monster.name.includes('군주') || monster.name.includes('디아블로') || monster.name.includes('메피스토') || monster.name.includes('바알') || monster.name.includes('릴리트')) reviveChance = 2;
  if(chance(reviveChance)){
    player.reviveTickets += 1;
    lines.push('🎫 부활권 +1');
  }

  lines.push(`✨ 경험치 +${monster.xp}`);
  const levelUps = giveXp(player, monster.xp);
  lines.push(...levelUps.map(v => `🎉 ${v}`));
  return { lines, levelUps };
}

function handleNoReviveDeath(player){
  player.run = null;
  player.hp = player.maxHp;
  player.respawnAt = Date.now() + 30*60*1000;
}
function enemyAttack(player, target, logs){
  if(!target || target.currentHp <= 0 || !player.run || player.run.isDown) return;
  if(chance(getDodge(player))){
    logs.push('💨 회피 성공!');
    return;
  }
  const dmg = Math.max(1, target.atk - getDefensePower(player));
  player.hp -= dmg;
  logs.push(`👿 ${target.name} → ${dmg} 피해!`);
  if(player.hp <= 0){
    player.hp = 0;
    if(player.reviveTickets > 0){
      player.run.isDown = true;
      logs.push('💀 쓰러졌습니다! [부활권] 버튼으로 수동 부활하세요.');
    } else {
      logs.push('💀 사망! 부활권이 없어 30분 대기입니다.');
      handleNoReviveDeath(player);
    }
  }
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
  if(!player.run) createRunIfNeeded(player, dungeonKey);
  if(player.run.isDown){
    result.logs.push('쓰러진 상태입니다. 먼저 부활권을 사용하세요.');
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
  let damage = (getAttackPower(player) + attrBonus - target.def) * mult;
  let critText = '';
  if(chance(getCritChance(player))){
    damage *= 1.5 + (getCritDamage(player)/100);
    critText = ' 💥치명타!';
  }
  damage = Math.max(1, Math.floor(damage));
  target.currentHp -= damage;
  result.logs.push(`👤 ${target.name}에게 ${damage} 피해!${critText}`);

  if(target.currentHp <= 0){
    target.currentHp = 0;
    result.killedTarget = { ...target };
    result.logs.push(`✅ ${target.name} 처치!`);
    const drops = grantDrops(player, target);
    result.levelUps = drops.levelUps;
    player.run.lastDrops = drops.lines;
    result.logs.push(...drops.lines);
    player.run.kills += 1;

    const dungeon = DUNGEONS[dungeonKey];
    if(dungeon.type === 'random'){
      player.run.target = null;
      player.run.nextTarget = getRandomMonster(dungeonKey);
      result.logs.push('다음 몬스터는 [공격] 버튼을 눌러 매칭하세요.');
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
function tryEnhanceItem(player, idx, elem){
  const item = player.inventory[idx];
  if(!item) return '없는 아이템입니다.';
  if((player.stones[elem]||0) < 1) return `${elem}석이 부족합니다.`;
  player.stones[elem] -= 1;
  item.elementEnhance[elem] = (item.elementEnhance[elem] || 0) + 1;
  if(item.type === 'weapon') item.atkBonus += 2;
  if(item.type === 'armor') item.defBonus += 2;
  if(item.type === 'ring'){
    const p = pick(['critChanceBonus','critDamageBonus','dodgeBonus']);
    item[p] += 1;
  }
  return `🔨 ${item.name} ${elem} 강화 성공!`;
}

function equipmentText(player){
  return [
    `⚔️ 무기: ${player.equipment.weapon ? player.equipment.weapon.name : '없음'}`,
    `🛡️ 갑옷: ${player.equipment.armor ? player.equipment.armor.name : '없음'}`,
    `💍 반지: ${player.equipment.ring ? player.equipment.ring.name : '없음'}`,
  ].join('\n');
}
function materialsText(player){
  const rows = Object.entries(player.materials).filter(([,v])=>v>0).map(([k,v])=>`${k} ${v}`);
  return rows.length ? rows.join(' / ') : '없음';
}
function inventoryText(player){
  if(!player.inventory.length) return '비어있음';
  return player.inventory.slice(0,15).map((it,idx)=>`${idx+1}. ${it.name} [${it.type}]`).join('\n');
}

function buildFullStatusText(player){
  return [
    `🏷️ 레벨: ${player.level} (${player.xp}/${player.nextXp})`,
    `🎯 스탯포인트: ${player.statPoints}`,
    `❤️ HP: ${player.hp}/${player.maxHp}`,
    `⚔️ 공격력: ${getAttackPower(player)}`,
    `🛡️ 방어력: ${getDefensePower(player)}`,
    `💥 크리확률: ${getCritChance(player)}%`,
    `🔥 크리데미지: +${getCritDamage(player)}%`,
    `💨 회피: ${getDodge(player)}%`,
    '',
    `⚔️ 무기: ${player.equipment.weapon ? player.equipment.weapon.name : '없음'}`,
    `🛡️ 갑옷: ${player.equipment.armor ? player.equipment.armor.name : '없음'}`,
    `💍 반지: ${player.equipment.ring ? player.equipment.ring.name : '없음'}`,
  ].join('\n');
}

function buildBagText(player){
  const mats = Object.entries(player.materials || {})
    .filter(([,v]) => v > 0)
    .map(([k,v]) => `${k} ${v}`)
    .join(' / ') || '없음';

  const items = player.inventory && player.inventory.length
    ? player.inventory.slice(0,15).map((it,idx)=>`${idx+1}. ${it.name} [${it.type}]`).join('\n')
    : '비어있음';

  return [
    `💰 골드: ${player.gold}`,
    `🎫 부활권: ${player.reviveTickets}`,
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
    lines.push(`⚡ 속성: ${target.element}`);
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

function buildBattleButtons(player, dungeonKey){
  const canAuto = DUNGEONS[dungeonKey]?.autoAllowed || false;
  const down = player.run?.isDown;

  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('attack').setLabel('⚔️ 공격').setStyle(ButtonStyle.Danger).setDisabled(down),
      new ButtonBuilder().setCustomId('use_small').setLabel('💊').setStyle(ButtonStyle.Secondary).setDisabled(down),
      new ButtonBuilder().setCustomId('use_mid').setLabel('🍗 ').setStyle(ButtonStyle.Secondary).setDisabled(down),
      new ButtonBuilder().setCustomId('status').setLabel('📋 상태창').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('bag_view').setLabel('🎒 가방').setStyle(ButtonStyle.Primary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('shop').setLabel('🏪 상점').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('use_big').setLabel('🍖 ').setStyle(ButtonStyle.Secondary).setDisabled(down),
      new ButtonBuilder().setCustomId('use_elixir').setLabel('🧪').setStyle(ButtonStyle.Secondary).setDisabled(down),
      new ButtonBuilder().setCustomId('auto').setLabel(canAuto ? '🤖 자동' : '자동불가').setStyle(canAuto ? ButtonStyle.Success : ButtonStyle.Secondary).setDisabled(!canAuto || down),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('revive').setLabel('💖 부활권').setStyle(ButtonStyle.Success).setDisabled(!down || player.reviveTickets<=0),
      new ButtonBuilder().setCustomId('craft_list').setLabel('🛠️ 제작').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('equipment_view').setLabel('🧰 장비').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('enhance_view').setLabel('🔨 강화').setStyle(ButtonStyle.Primary),
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
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('buy_small').setLabel('💊 10G').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('buy_mid').setLabel(' 🍗 30G').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('buy_big').setLabel(' 🍖 100G').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('buy_elixir').setLabel(' 🧪 3000G').setStyle(ButtonStyle.Secondary),
  )];
}
function buildCraftButtons(){
  const rows = [];
  for(let i=0;i<CRAFTS.length;i+=4){
    rows.push(new ActionRowBuilder().addComponents(
      ...CRAFTS.slice(i,i+4).map(c => new ButtonBuilder().setCustomId(`craft_${c.id}`).setLabel(c.label).setStyle(ButtonStyle.Primary))
    ));
  }
  return rows.slice(0,5);
}
function buildEquipmentButtons(player){
  if(!player.inventory.length) return [];
  const rows = [];
  for(let i=0;i<Math.min(12, player.inventory.length);i+=4){
    rows.push(new ActionRowBuilder().addComponents(
      ...player.inventory.slice(i,i+4).map((it,idx)=> new ButtonBuilder().setCustomId(`equip_${i+idx}`).setLabel(`${i+idx+1}.${it.type}`).setStyle(ButtonStyle.Primary))
    ));
  }
  return rows;
}
function buildEnhanceItemButtons(player){
  if(!player.inventory.length) return [];
  const rows = [];
  for(let i=0;i<Math.min(12, player.inventory.length);i+=4){
    rows.push(new ActionRowBuilder().addComponents(
      ...player.inventory.slice(i,i+4).map((it,idx)=> new ButtonBuilder().setCustomId(`enhance_item_${i+idx}`).setLabel(`${i+idx+1}.${it.type}`).setStyle(ButtonStyle.Primary))
    ));
  }
  return rows;
}
function buildEnhanceElementButtons(){
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('enhance_elem_화염').setLabel('화염').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('enhance_elem_얼음').setLabel('얼음').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('enhance_elem_번개').setLabel('번개').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('enhance_elem_자연').setLabel('자연').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('enhance_elem_어둠').setLabel('어둠').setStyle(ButtonStyle.Secondary),
  )];
}

function buildIntroPayload(dungeonKey, target){
  if(!target){
    return { embeds:[new EmbedBuilder().setTitle('⚠️ 몬스터 없음').setDescription('현재 표시할 몬스터가 없습니다.').setColor(0x555555)] };
  }
  const embed = new EmbedBuilder()
    .setTitle(`👁️ ${target.name} 등장`)
    .setDescription(`던전: ${DISPLAY_NAMES[dungeonKey]}\n속성: ${target.element}\n\n1초 후 전투를 시작합니다...`)
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
async function deletePreviousDropMessage(channel, player){
  if(player.run?.dropMessageId){
    try {
      const oldMsg = await channel.messages.fetch(player.run.dropMessageId);
      await oldMsg.delete();
    } catch (e) {}
    if(player.run) player.run.dropMessageId = null;
  }
}

async function maybeTownBroadcast(client, msg){
  try {
    const channel = await client.channels.fetch('1487955862940024862');
    if(channel){
      await channel.send(msg);
    }
  } catch (e) {
    console.log('마을 알림 실패:', e.message);
  }
}

async function sendTemporaryDropMessage(channel, player, lines){
  await deletePreviousDropMessage(channel, player);
  const msg = await channel.send(`🎁 드랍템\n${lines.join('\n')}`);
  if(player.run) player.run.dropMessageId = msg.id;

  setTimeout(async () => {
    try { await msg.delete(); } catch (e) {}
  }, TEMP_DROP_DELETE_MS);
}

async function spawnNextTargetByInteraction(interaction, player, dungeonKey){
  if(!player.run?.nextTarget){
    await interaction.followUp({ content:'다음 몬스터가 없습니다.', ephemeral:true });
    return;
  }

  player.run.lastDrops = [];
  await deletePreviousDropMessage(interaction.channel, player);

  player.run.target = player.run.nextTarget;
  player.run.nextTarget = null;
  saveData(db);

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

function craftListText(player){
  return CRAFTS.map(c => {
    const mats = Object.entries(c.materials).map(([m,n]) => `${m}${n}`).join(' / ');
    return `- ${c.label} / ${mats} / ${canCraft(player,c)?'제작가능':'부족'}`;
  }).join('\n');
}
function getCraftIdByLabel(label){
  const f = CRAFTS.find(c => c.label === label);
  return f ? f.id : null;
}

client.once('ready', ()=>{
  console.log(`${client.user.tag} 로그인 완료`);
});

client.on('messageCreate', async (message)=>{
  if(message.author.bot) return;
  if(!isAllowedCategory(message.channel)) return;
  if(!message.content.startsWith('!')) return;

  const parts = message.content.trim().split(/\s+/);
  const command = parts[0];
  const arg = parts[1];
  const player = getPlayer(message.author.id);
  const dungeonKey = getDungeonByChannel(message.channel.id);


  if(command === '!가방'){
    saveData(db);
    await message.reply({ content:buildBagText(player) });
    return;
  }

  if(command === '!도움말'){
    await message.reply(formatHelp());
    return;
  }
  if(command === '!초기화'){
    db[message.author.id] = getDefaultPlayer(message.author.id);
    saveData(db);
    await message.reply('초기화 완료');
    return;
  }
  if(Date.now() < player.respawnAt){
    const min = Math.ceil((player.respawnAt - Date.now())/60000);
    await message.reply(`💀 아직 사망 페널티 중입니다. 약 ${min}분 후 다시 가능합니다.`);
    return;
 }
  if(command === '!상태'){
    saveData(db);
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
  }
  if(command === '!제작목록'){
    await message.reply({ content:`🛠️ 제작목록\n${craftListText(player)}`, components:buildCraftButtons() });
    return;
  }
  if(command === '!제작'){
    const craftId = getCraftIdByLabel(arg);
    if(!craftId){
      await message.reply('없는 제작식입니다.');
      return;
    }
    const res = tryCraft(player, craftId);
    saveData(db);
    await message.reply(res.text);
    return;
  }
  if(command === '!장착'){
    const idx = Number(arg) - 1;
    if(Number.isNaN(idx)){ await message.reply('사용법: !장착 1'); return; }
    const text = equipItemByIndex(player, idx);
    saveData(db);
    await message.reply(text);
    return;
  }
  if(command === '!강화'){
    if(!arg || !ELEMENTS.includes(arg)){
      await message.reply(`사용법: !강화 ${ELEMENTS.join('|')}`);
      return;
    }
    const active = Object.keys(player.attributes);
    if(!player.attributes[arg] && active.length >= 2){
      await message.reply('속성은 최대 2개까지만 강화할 수 있습니다.');
      return;
    }
    if((player.stones[arg]||0) < 1){
      await message.reply(`${arg}석이 부족합니다.`);
      return;
    }
    player.stones[arg] -= 1;
    player.attributes[arg] = (player.attributes[arg] || 0) + 1;
    saveData(db);
    await message.reply(`💎 ${arg} 강화 성공! 현재 ${arg}+${player.attributes[arg]}`);
    return;
  }
  if(command === '!자동'){
    if(!dungeonKey){ await message.reply('이 명령어는 던전 채널에서만 가능합니다.'); return; }
    if(!DUNGEONS[dungeonKey].autoAllowed){ await message.reply('이 던전은 자동사냥이 불가능합니다.'); return; }
    createRunIfNeeded(player, dungeonKey);
    saveData(db);
    const introTarget = player.run?.target || player.run?.nextTarget;
    await message.reply(buildIntroPayload(dungeonKey, introTarget));
    await sleep(INTRO_DELAY_MS);
    const logs = ['🤖 자동사냥 시작'];
    let dropLines = null;
    for(let i=0;i<5;i++){
      if(!player.run) break;
      if(player.run.isDown) break;
      if(!player.run.target && player.run.nextTarget){
        player.run.target = player.run.nextTarget;
        player.run.nextTarget = null;
        logs.push(`\n[${i+1}턴]\n✨ 다음 몬스터 매칭: ${player.run.target.name}`);
        continue;
      }
      const result = performAttack(player, dungeonKey);
      logs.push(`\n[${i+1}턴]\n${result.logs.join('\n')}`);
      if(player.run?.lastDrops?.length) dropLines = [...player.run.lastDrops];
      //await maybeTownBroadcast(message.author.username, dungeonKey, result);
      if(Date.now() < player.respawnAt) break;
    }
    saveData(db);
    await message.reply(buildBattlePayload(player, message.channel.id, dungeonKey, logs.join('\n')));
    if(dropLines) await sendTemporaryDropMessage(interaction.channel, player, player.run.lastDrops);
    return;
  }
  if(command === '!시작'){
    if(!dungeonKey){ await message.reply('이 명령어는 지정한 던전 채널에서만 가능합니다.'); return; }
    createRunIfNeeded(player, dungeonKey);
    saveData(db);
    const introTarget = player.run?.target || player.run?.nextTarget;
    await message.reply(buildIntroPayload(dungeonKey, introTarget));
    await sleep(INTRO_DELAY_MS);
    await message.reply(buildBattlePayload(player, message.channel.id, dungeonKey, '전투 시작!'));
    return;
  }
});

client.on('interactionCreate', async (interaction)=>{
  if(!interaction.isButton()) return;

  const player = getPlayer(interaction.user.id);
  const dungeonKey = getDungeonByChannel(interaction.channelId);
  const id = interaction.customId;

   if(id === 'bag_view'){
    await interaction.deferReply({ ephemeral:true });
    await interaction.editReply({ content:buildBagText(player) });
    return;
  }


  if(Date.now() < player.respawnAt){
    const min = Math.ceil((player.respawnAt - Date.now())/60000);
    await interaction.reply({ content:`💀 아직 사망 페널티 중입니다. 약 ${min}분 남았습니다.`, ephemeral:true });
    return;
  }

  if(id === 'status'){
    await interaction.deferReply({ ephemeral:true });
    saveData(db);
    await interaction.editReply({ content:buildFullStatusText(player), components:buildStatusButtons(player) });
    return;
  }

if(id === 'shop'){
  await interaction.deferReply({ ephemeral:true });
  await interaction.editReply({
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
 
  if(id === 'craft_list'){
    await interaction.deferReply({ ephemeral:true });
    await interaction.editReply({ content:`🛠️ 제작목록\n${craftListText(player)}`, components:buildCraftButtons() });
    return;
  }
  if(id === 'equipment_view'){
    await interaction.deferReply({ ephemeral:true });
    await interaction.editReply({ content:`${equipmentText(player)}\n\n인벤토리\n${inventoryText(player)}`, components:buildEquipmentButtons(player) });
    return;
  }
  if(id === 'enhance_view'){
    await interaction.deferReply({ ephemeral:true });
    player.selectedEnhanceIndex = null;
    saveData(db);
    await interaction.editReply({ content:`강화할 아이템 선택\n${inventoryText(player)}\n\n보유 속성석: ${Object.entries(player.stones).map(([k,v])=>`${k}${v}`).join(' / ')}`, components:buildEnhanceItemButtons(player) });
    return;
  }
  if(id.startsWith('enhance_item_')){
    await interaction.deferReply({ ephemeral:true });
    const idx = Number(id.replace('enhance_item_',''));
    player.selectedEnhanceIndex = idx;
    saveData(db);
    await interaction.editReply({ content:`선택 아이템: ${player.inventory[idx] ? player.inventory[idx].name : '없음'}\n속성을 선택하세요.`, components:buildEnhanceElementButtons() });
    return;
  }
  if(id.startsWith('enhance_elem_')){
    await interaction.deferReply({ ephemeral:true });
    if(player.selectedEnhanceIndex === null || player.selectedEnhanceIndex === undefined){
      await interaction.editReply({ content:'먼저 강화할 아이템을 선택하세요.' });
      return;
    }
    const elem = id.replace('enhance_elem_','');
    const text = tryEnhanceItem(player, player.selectedEnhanceIndex, elem);
    saveData(db);
    await interaction.editReply({ content:text });
    return;
  }
  if(id.startsWith('craft_') && id !== 'craft_list'){
    await interaction.deferReply({ ephemeral:true });
    const craftId = id.replace('craft_','');
    const res = tryCraft(player, craftId);
    saveData(db);
    await interaction.editReply({ content:res.text });
    return;
  }
  if(id.startsWith('equip_')){
    await interaction.deferReply({ ephemeral:true });
    const idx = Number(id.replace('equip_',''));
    const text = equipItemByIndex(player, idx);
    saveData(db);
    await interaction.editReply({ content:`${text}\n\n${equipmentText(player)}` });
    return;
  }
  if(id === 'stat_atk' || id === 'stat_crit' || id === 'stat_critdmg' || id === 'stat_dodge'){
    await interaction.deferReply({ ephemeral:true });
    const map = { stat_atk:'atk', stat_crit:'critChance', stat_critdmg:'critDamage', stat_dodge:'dodge' };
    const text = tryUpgradeStat(player, map[id]);
    saveData(db);
    await interaction.editReply({ content:`${text}\n\n${buildFullStatusText(player)}`, components:buildStatusButtons(player) });
    return;
  }
  if(id.startsWith('buy_')){
    await interaction.deferReply({ ephemeral:true });
    const key = id.replace('buy_','');
    const item = SHOP[key];
    if(!item){ await interaction.editReply({ content:'구매 오류' }); return; }
    if(player.gold < item.price){ await interaction.editReply({ content:'골드가 부족합니다.' }); return; }
    player.gold -= item.price;
    player.potions[key] += 1;
    saveData(db);
    await interaction.editReply({ content:`구매 완료: ${item.label} 1개` });
    return;
  }
  if(id === 'revive'){
    await interaction.deferUpdate();
    if(!player.run?.isDown){
      await interaction.followUp({ content:'지금은 부활권을 사용할 수 없습니다.', ephemeral:true });
      return;
    }
    if(player.reviveTickets <= 0){
      await interaction.followUp({ content:'부활권이 없습니다.', ephemeral:true });
      return;
    }
    player.reviveTickets -= 1;
    player.hp = Math.max(1, Math.floor(player.maxHp * 0.5));
    player.run.isDown = false;
    saveData(db);
    await interaction.message.edit(buildBattlePayload(player, interaction.channelId, player.run.dungeon, '🪽 부활권 사용! 체력 50%로 부활했습니다.'));
    return;
  }
  if(id.startsWith('use_')){
    const key = id.replace('use_','');
    if(player.run?.target && dungeonKey){
      await interaction.deferUpdate();
      const result = usePotionInBattle(player, key);
      saveData(db);
      await interaction.message.edit(buildBattlePayload(player, interaction.channelId, dungeonKey, result.logs.join('\n')));
      return;
    }
    await interaction.deferReply({ ephemeral:true });
    const text = usePotionOutOfBattle(player, key);
    saveData(db);
    await interaction.editReply({ content:text });
    return;
  }

  if(!dungeonKey){
    await interaction.reply({ content:'이 버튼은 던전 채널에서만 사용할 수 있습니다.', ephemeral:true });
    return;
  }

  if(id === 'auto'){
    await interaction.deferUpdate();
    if(!DUNGEONS[dungeonKey].autoAllowed){
      await interaction.followUp({ content:'이 던전은 자동사냥이 불가능합니다.', ephemeral:true });
      return;
    }
    if(!player.run) createRunIfNeeded(player, dungeonKey);
    const logs = ['🤖 자동사냥 시작'];
    let dropLines = null;
    for(let i=0;i<5;i++){
      if(!player.run) break;
      if(player.run.isDown) break;
      if(!player.run.target && player.run.nextTarget){
        player.run.target = player.run.nextTarget;
        player.run.nextTarget = null;
        logs.push(`\n[${i+1}턴]\n✨ 다음 몬스터 매칭: ${player.run.target.name}`);
        continue;
      }
      const result = performAttack(player, dungeonKey);
      logs.push(`\n[${i+1}턴]\n${result.logs.join('\n')}`);
      if(player.run?.lastDrops?.length) dropLines = [...player.run.lastDrops];
     // await maybeTownBroadcast(interaction.user.username, dungeonKey, result);
      if(Date.now() < player.respawnAt) break;
    }
    saveData(db);
    await interaction.message.edit(buildBattlePayload(player, interaction.channelId, dungeonKey, logs.join('\n')));
    if(dropLines) await sendTemporaryDropMessage(interaction.channel, player, player.run.lastDrops);
    return;
  }

  if(id === 'attack'){
   // await interaction.deferUpdate();
    if(!player.run) createRunIfNeeded(player, dungeonKey);

    if(!player.run.target && player.run.nextTarget){
      await spawnNextTargetByInteraction(interaction, player, dungeonKey);
      return;
    }

    const result = performAttack(player, dungeonKey);
    saveData(db);
   // await maybeTownBroadcast(interaction.user.username, dungeonKey, result);
    await interaction.message.edit(buildBattlePayload(player, interaction.channelId, dungeonKey, result.logs.join('\n')));
    if(player.run?.lastDrops?.length) await sendTemporaryDropMessage(interaction.channel, player, player.run.lastDrops);
    return;
  }
});


const token = process.env.DISCORD_TOKEN;
client.login(token);
