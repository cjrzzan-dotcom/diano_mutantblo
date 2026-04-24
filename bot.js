require('dotenv').config();

const path = require('path');
const fs = require('fs');
const { MongoClient } = require('mongodb');

const MODE = process.env.MODE || 'test';

const DATA_FILE = path.join(
  __dirname,
  MODE === 'prod'
    ? (process.env.DATA_FILE_PROD || 'data_rpg_girin.json')
    : (process.env.DATA_FILE_TEST || 'data_rpg_test.json')
);

console.log("MONGO_URI 있음?", !!process.env.MONGO_URI);

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

  // ⭐ 백업 삭제는 여기서
  await playersCol.deleteOne({ _id: '__backup__' });
  await playersCol.deleteMany({ type: 'rolling_backup' });
  console.log('🔥 백업 삭제 완료');

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

async function safeSave(playerOrUserId){
  try {
    await savePlayer(playerOrUserId);
  } catch (err) {
    console.error('❌ safeSave 실패:', err);
  }
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

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});



const AUTO_HUNT_CHARGE_MS = 1 * 60 * 1000; // 1분
const AUTO_HUNT_MAX_CHARGES = 50;
const AUTO_HUNT_TURNS = 500;


function isAdmin(message) {
  // 네 아이디만 허용하려면 아래처럼 바꿔도 됨
return message.author.id === '335720453408817166';
}

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
  await safeSave(player);
  return sent;
}

function clearBattleMessage(player){
  player.battleMessageId = null;
  player.battleChannelId = null;
}

function randInt(min, max){
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function tryTemperItem(player, item){
  if (!item) return '❌ 없는 아이템입니다.';
  if (!player.materials) player.materials = {};

  if (item.temperCount === undefined) item.temperCount = 0;

  const needMat = 3;
  const maxTemper = 5;
  const matName = '세계석조각';

  if (item.temperCount >= maxTemper) {
    return `❌ ${item.name}은(는) 이미 담금질 최대(${maxTemper}회)입니다.`;
  }

  if ((player.materials[matName] || 0) < needMat) {
    return `❌ ${matName}이 부족합니다. (${needMat}개 필요)`;
  }

  player.materials[matName] -= needMat;

  if (item.type === 'weapon') {
    const value = randInt(1, 3);
    item.atkBonus = (item.atkBonus || 0) + value;
    item.temperCount += 1;
    return `⚒️ ${item.name} 담금질 성공!\n공격력 +${value}\n(담금질 ${item.temperCount}/5)`;
  }

  if (item.type === 'armor') {
    const value = randInt(1, 3);
    item.defBonus = (item.defBonus || 0) + value;
    item.temperCount += 1;
    return `⚒️ ${item.name} 담금질 성공!\n방어력 +${value}\n(담금질 ${item.temperCount}/5)`;
  }

  if (item.type === 'ring') {
    const value = randInt(1, 2);
    item.atkBonus = (item.atkBonus || 0) + value;
    item.defBonus = (item.defBonus || 0) + value;
    item.critChanceBonus = (item.critChanceBonus || 0) + value;
    item.critDamageBonus = (item.critDamageBonus || 0) + value;
    item.dodgeBonus = (item.dodgeBonus || 0) + value;
    item.temperCount += 1;
    return `⚒️ ${item.name} 담금질 성공!\n모든 스탯 +${value}\n(담금질 ${item.temperCount}/5)`;
  }

  player.materials[matName] += needMat;
  return '❌ 담금질할 수 없는 아이템 종류입니다.';
}


function reviveIfRespawnReady(player){
  if(!player.run) return false;
  if(!player.run.isDown) return false;
  if(!player.respawnAt) return false;
  if(Date.now() < player.respawnAt) return false;

  player.run.isDown = false;
  player.hp = Math.max(1, Math.floor(getMaxHpWithBless(player)));
  player.respawnAt = 0;
  return true;
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
  };
}

function getGroupedRunes(player) {
  if (!player.runes) player.runes = [];

  const map = new Map();

  for (const rune of player.runes) {
    if (!rune) continue;

    if (!map.has(rune.key)) {
      map.set(rune.key, {
        key: rune.key,
        name: rune.name,
        stats: rune.stats,
        count: 0
      });
    }

    map.get(rune.key).count += 1;
  }

  return Array.from(map.values());
}

function getRuneBonus(player) {
  const bonus = {
    atk: 0,
    def: 0,
    critDamage: 0,
    hpPercent: 0
  };

  if (!player.equippedRunes) return bonus;

  for (const rune of player.equippedRunes) {
    if (!rune) continue;

    const s = rune.stats;
    if (!s) continue;

    if (s.atk) bonus.atk += s.atk;
    if (s.def) bonus.def += s.def;
    if (s.critDamage) bonus.critDamage += s.critDamage;
    if (s.hpPercent) bonus.hpPercent += s.hpPercent;
  }

  return bonus;
}

function isRuneAlreadyEquipped(player, runeKey) {
  if (!player.equippedRunes) {
    player.equippedRunes = [null, null, null, null];
  }

  return player.equippedRunes.some(rune => rune && rune.key === runeKey);
}

function getEquippedRuneKeys(player) {
  if (!player.equippedRunes) {
    player.equippedRunes = [null, null, null, null];
  }

  return player.equippedRunes.map(r => (r ? r.key : null));
}

function getRuneComboKey(player) {
  const keys = getEquippedRuneKeys(player);
  if (keys.some(k => !k)) return null;
  return keys.join('-');
}

const RUNES = [
  {
    key: 'destroy',
    name: '🔥 파괴의 룬',
    stats: { atk: 15 }
  },
  {
    key: 'guard',
    name: '🛡 수호의 룬',
    stats: { def: 15 }
  },
  {
    key: 'rage',
    name: '⚡ 광폭의 룬',
    stats: { atk: 5, critDamage: 20, def: -5 }
  },
  {
    key: 'life',
    name: '🌿 생명의 룬',
    stats: { hpPercent: 10, atk: -15 }
  },
  {
    key: 'balance',
    name: '⚖️ 균형의 룬',
    stats: { atk: 5, def: 5, critDamage: 10 }
  }
];

const LEGENDARY_RUNE_COMBOS = {
  'life-rage-destroy-balance': {
    tier: 'legendary',
    name: '흡혈 폭주',
    atk: 20,
    lifesteal: 10
  },

  'rage-guard-balance-destroy': {
    tier: 'legendary',
    name: '광기의 연격',
    extraHitChance: 30,
    extraHitDamageRate: 0.5
  },

  'guard-life-rage-balance': {
    tier: 'legendary',
    name: '철벽 수호',
    def: 10,
    damageReduce: 15
  },

  'life-balance-guard-destroy': {
    tier: 'legendary',
    name: '불사의 심장',
    hpPercent: 20,
    lowHpAtkPercent: 20,
    lowHpThreshold: 30
  },

  'destroy-rage-balance-life': {
    tier: 'legendary',
    name: '치명 폭발',
    critChance: 10,
    critDamage: 30
  }
};

const AUTO_COMBO_DISTRIBUTION = {
  unique: 15,
  epic: 20,
  rare: 35,
  normal: 45
};

const AUTO_COMBO_STATS = {
  unique: {
    atk: 18,
    def: 18,
    critDamage: 35
  },
  epic: {
    atk: 12,
    def: 12,
    critDamage: 22
  },
  rare: {
    atk: 8,
    def: 8,
    critDamage: 15
  },
  normal: {
    atk: 0,
    def: 0,
    critDamage: 0
  }
};

function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function generateAllRuneComboKeys() {
  const keys = RUNES.map(r => r.key);
  const out = [];

  for (const a of keys) {
    for (const b of keys) {
      if (b === a) continue;
      for (const c of keys) {
        if (c === a || c === b) continue;
        for (const d of keys) {
          if (d === a || d === b || d === c) continue;
          out.push(`${a}-${b}-${c}-${d}`);
        }
      }
    }
  }

  return out;
}

function formatRuneStats(stats) {
  if (!stats) return '없음';

  const lines = [];

  if (stats.atk) lines.push(`⚔️ 공격력 +${stats.atk}`);
  if (stats.def) lines.push(`🛡️ 방어력 +${stats.def}`);
  if (stats.critChance) lines.push(`💥 크확 +${stats.critChance}%`);
  if (stats.critDamage) lines.push(`🔥 크뎀 +${stats.critDamage}%`);
  if (stats.hpPercent) lines.push(`❤️ 체력 +${stats.hpPercent}%`);

  return lines.length ? lines.join(', ') : '옵션 없음';
}

function buildAutoComboTable() {
  const allKeys = generateAllRuneComboKeys();

  const legendaryKeys = new Set(Object.keys(LEGENDARY_RUNE_COMBOS));
  const normalKeys = allKeys.filter(key => !legendaryKeys.has(key));

  normalKeys.sort((a, b) => {
    const ha = simpleHash(a);
    const hb = simpleHash(b);
    if (ha !== hb) return ha - hb;
    return a.localeCompare(b);
  });

  const table = {};
  let index = 0;

  const assignTierBlock = (tier, count) => {
    for (let i = 0; i < count; i++) {
      const comboKey = normalKeys[index++];
      if (!comboKey) break;

      const typeIndex = i % 3;
      let type = 'atk';
      if (typeIndex === 1) type = 'def';
      if (typeIndex === 2) type = 'critDamage';

      table[comboKey] = {
        tier,
        type,
        name:
          tier === 'unique' ? '유니크 조합' :
          tier === 'epic' ? '에픽 조합' :
          tier === 'rare' ? '레어 조합' :
          '일반 조합',
        atk: type === 'atk' ? AUTO_COMBO_STATS[tier].atk : 0,
        def: type === 'def' ? AUTO_COMBO_STATS[tier].def : 0,
        critChance: 0,
        critDamage: type === 'critDamage' ? AUTO_COMBO_STATS[tier].critDamage : 0,
        hpPercent: 0,
        lifesteal: 0,
        damageReduce: 0,
        extraHitChance: 0,
        extraHitDamageRate: 0,
        lowHpAtkPercent: 0,
        lowHpThreshold: 0
      };
    }
  };

  assignTierBlock('unique', AUTO_COMBO_DISTRIBUTION.unique);
  assignTierBlock('epic', AUTO_COMBO_DISTRIBUTION.epic);
  assignTierBlock('rare', AUTO_COMBO_DISTRIBUTION.rare);

  while (index < normalKeys.length) {
    const comboKey = normalKeys[index++];
    table[comboKey] = {
      tier: 'normal',
      type: 'none',
      name: '일반 조합',
      atk: 0,
      def: 0,
      critChance: 0,
      critDamage: 0,
      hpPercent: 0,
      lifesteal: 0,
      damageReduce: 0,
      extraHitChance: 0,
      extraHitDamageRate: 0,
      lowHpAtkPercent: 0,
      lowHpThreshold: 0
    };
  }

  return table;
}

const AUTO_RUNE_COMBOS = buildAutoComboTable();

function getRuneSetBonus(player) {
  const comboKey = getRuneComboKey(player);

  const empty = {
    tier: null,
    name: null,
    atk: 0,
    def: 0,
    critChance: 0,
    critDamage: 0,
    hpPercent: 0,
    lifesteal: 0,
    damageReduce: 0,
    extraHitChance: 0,
    extraHitDamageRate: 0,
    lowHpAtkPercent: 0,
    lowHpThreshold: 0
  };

  if (!comboKey) return empty;

  const legendary = LEGENDARY_RUNE_COMBOS[comboKey];
  if (legendary) {
    return {
      tier: legendary.tier || 'legendary',
      name: legendary.name || '전설 조합',
      atk: legendary.atk || 0,
      def: legendary.def || 0,
      critChance: legendary.critChance || 0,
      critDamage: legendary.critDamage || 0,
      hpPercent: legendary.hpPercent || 0,
      lifesteal: legendary.lifesteal || 0,
      damageReduce: legendary.damageReduce || 0,
      extraHitChance: legendary.extraHitChance || 0,
      extraHitDamageRate: legendary.extraHitDamageRate || 0,
      lowHpAtkPercent: legendary.lowHpAtkPercent || 0,
      lowHpThreshold: legendary.lowHpThreshold || 0
    };
  }

  const auto = AUTO_RUNE_COMBOS[comboKey];
  if (!auto) return empty;

  return {
    tier: auto.tier,
    name: auto.name,
    atk: auto.atk || 0,
    def: auto.def || 0,
    critChance: auto.critChance || 0,
    critDamage: auto.critDamage || 0,
    hpPercent: auto.hpPercent || 0,
    lifesteal: auto.lifesteal || 0,
    damageReduce: auto.damageReduce || 0,
    extraHitChance: auto.extraHitChance || 0,
    extraHitDamageRate: auto.extraHitDamageRate || 0,
    lowHpAtkPercent: auto.lowHpAtkPercent || 0,
    lowHpThreshold: auto.lowHpThreshold || 0
  };
}

function getRuneSetText(player) {
  const setBonus = getRuneSetBonus(player);

  if (!setBonus.name) {
    return '발동 중인 조합 없음';
  }

  const tierLabel =
    setBonus.tier === 'legendary' ? '전설' :
    setBonus.tier === 'unique' ? '유니크' :
    setBonus.tier === 'epic' ? '에픽' :
    setBonus.tier === 'rare' ? '레어' :
    '일반';

  const lines = [`${setBonus.name} (${tierLabel})`];

  if (setBonus.atk) lines.push(`공격력 +${setBonus.atk}`);
  if (setBonus.def) lines.push(`방어력 +${setBonus.def}`);
  if (setBonus.critChance) lines.push(`크리확률 +${setBonus.critChance}%`);
  if (setBonus.critDamage) lines.push(`크리데미지 +${setBonus.critDamage}%`);
  if (setBonus.hpPercent) lines.push(`체력 +${setBonus.hpPercent}%`);
  if (setBonus.lifesteal) lines.push(`흡혈 +${setBonus.lifesteal}%`);
  if (setBonus.damageReduce) lines.push(`피해감소 +${setBonus.damageReduce}%`);
  if (setBonus.extraHitChance) lines.push(`추가타 확률 +${setBonus.extraHitChance}%`);
  if (setBonus.extraHitDamageRate) lines.push(`추가타 피해 +${Math.round(setBonus.extraHitDamageRate * 100)}%`);
  if (setBonus.lowHpAtkPercent) {
    lines.push(`체력 ${setBonus.lowHpThreshold}% 이하 시 공격력 +${setBonus.lowHpAtkPercent}%`);
  }

  return lines.join('\n');
}


function buildBlessButtons(player){
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('bless_weapon')
        .setLabel('⚔️ 무기')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(!player.equipment?.weapon),

      new ButtonBuilder()
        .setCustomId('bless_armor')
        .setLabel('🛡️ 갑옷')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(!player.equipment?.armor),

      new ButtonBuilder()
        .setCustomId('bless_ring')
        .setLabel('💍 반지')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
    )
  ];
}

function createRandomOptionsByRarity(rarityKey){
  const optionPool = [
    'atkBonus',
    'defBonus',
    'critChanceBonus',
    'critDamageBonus',
    'dodgeBonus'
  ];

  let min = 0, max = 0;

  if (rarityKey === 'common') { min = 0; max = 0; }
  if (rarityKey === 'rare') { min = 0; max = 1; }
  if (rarityKey === 'epic') { min = 1; max = 2; }
  if (rarityKey === 'unique') { min = 2; max = 3; }
  if (rarityKey === 'legendary') { min = 5; max = 5; }

  const count = randInt(min, max);

  const picked = [];
  while (picked.length < count) {
    const p = pick(optionPool);
    if (!picked.includes(p)) picked.push(p);
  }

  const out = {
    atkBonus: 0,
    defBonus: 0,
    critChanceBonus: 0,
    critDamageBonus: 0,
    dodgeBonus: 0,
  };

  for (const p of picked) {
    if (p === 'atkBonus') out[p] += randInt(2, 6);
    if (p === 'defBonus') out[p] += randInt(2, 6);
    if (p === 'critChanceBonus') out[p] += randInt(2, 8);   // %
    if (p === 'critDamageBonus') out[p] += randInt(5, 15);   // %
    if (p === 'dodgeBonus') out[p] += randInt(2, 8);         // %
  }

  return out;
}

function tryBlessItem(player, item){
  if (!item) return '❌ 없는 장비입니다.';
  if (!player.materials) player.materials = {};

  if ((player.materials['축성석'] || 0) < 1) {
    return '❌ 축성석이 부족합니다.';
  }

  if (item.blessing) {
    return `❌ ${item.name}은(는) 이미 축성되었습니다.`;
  }

  let options = [];

  if (item.type === 'weapon') {
    options = [
      { key: 'atkPercent', label: '공격력 15% 증가', value: 15 },
      { key: 'critChance', label: '크리확률 10% 증가', value: 10 },
      { key: 'critDamage', label: '크리데미지 20% 증가', value: 20 },
      { key: 'lifesteal', label: '흡혈 15%', value: 15 },
    ];
  } else if (item.type === 'armor') {
    options = [
      { key: 'flatDef', label: '방어력 +20', value: 20 },
      { key: 'dodge', label: '회피 15% 증가', value: 15 },
      { key: 'hpPercent', label: '체력 15% 증가', value: 15 },
      { key: 'reflect', label: '데미지반사 15%', value: 15 },
    ];
  } else if (item.type === 'ring') {
    return '❌ 반지는 아직 축성할 수 없습니다.';
  } else {
    return '❌ 축성할 수 없는 장비입니다.';
  }

  const blessed = pick(options);

  player.materials['축성석'] -= 1;
  item.blessing = {
    key: blessed.key,
    label: blessed.label,
    value: blessed.value,
  };

  return `✨ ${item.name} 축성 성공!\n[${blessed.label}] 부여됨`;
}

function getBlessingBonuses(item){
  const out = {
    atkPercent: 0,
    critChance: 0,
    critDamage: 0,
    lifesteal: 0,
    flatDef: 0,
    dodge: 0,
    hpPercent: 0,
    reflect: 0,
  };

  if (!item || !item.blessing) return out;

  const key = item.blessing.key;
  const value = item.blessing.value || 0;

  if (key === 'atkPercent') out.atkPercent = value;
  if (key === 'critChance') out.critChance = value;
  if (key === 'critDamage') out.critDamage = value;
  if (key === 'lifesteal') out.lifesteal = value;
  if (key === 'flatDef') out.flatDef = value;
  if (key === 'dodge') out.dodge = value;
  if (key === 'hpPercent') out.hpPercent = value;
  if (key === 'reflect') out.reflect = value;

  return out;
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
  if (!item) return 0;

  const base = GRADE_SELL_PRICE[item.grade || item.rarity || 'common'] || 50;

  const atk = item.atkBonus || 0;
  const def = item.defBonus || 0;
  const crit = item.critChanceBonus || 0;
  const critDmg = item.critDamageBonus || 0;
  const dodge = item.dodgeBonus || 0;
  const enhanceLevel = item.enhanceLevel || 0;

  const statValue =
    atk * 8 +
    def * 8 +
    crit * 12 +
    critDmg * 10 +
    dodge * 12;

  const enhanceValue = enhanceLevel * 25;

  const price = base + statValue + enhanceValue;

  return Math.max(10, Math.floor(price));
}

const IMAGE_PATH = path.join(__dirname, 'images');
const INTRO_DELAY_MS = 1000;
const TEMP_DROP_DELETE_MS = 5000;
const TOWN_CHANNEL_IDS = new Set([
  '1487955862940024862',
  '1486949446171365449',
  '1496420160138117150',
  '1496420457090646147',
]);


const MATERIAL_PRICES = {
  '슬라임젤리': 30,
  '늑대가죽': 30,
  '고블린뼈조각': 30,
  '오우거가죽': 30,
  '작은 용비늘': 30,

  '낡은장비조각': 50,

  '드래곤 비늘': 100,
  '드래곤 발톱': 100,
  '번개조각': 100,
  '얼음조각': 100,
  '붉은화염조각': 100,
  '푸른화염조각': 100,
  '어둠조각': 100,

  '좀비드래곤의 피': 150,

  '메탈조각': 200,

  '좀비드래곤의 가죽': 300,

  '빛의 조각': 350,

  '암흑의 조각': 400,

  '도살자의 도끼조각': 450,
  '레오릭왕의 뼈조각': 450,
  '악마의 정수': 450,
  '악마의 살점': 450,

  '릴리트의 뿔': 500,
  '고급장비조각': 500,
  '천상석': 500,

  '디아블로의 뿔': 700,

  '천상의 조각': 1000,
  '디아블로의 불': 1000,
  '세계석조각': 2,
  '부활권':500000,

};

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
  large: { label: '🥩 대형물약', heal: 200, price: 500 },
  huge: { label: '🍖🍖 특대물약', heal: 300, price: 1000 },
  elixir: { label: '🧪 엘릭서', heal: 99999, price: 3000 },

  advanced_part: { label: '🧩 고급장비조각', price: 5000 },
  rune_stone: { label: '🌠 룬소환석', price: 300000 }, // ⭐ 이모지 추가
};


function drawRune() {
  const rune = RUNES[Math.floor(Math.random() * RUNES.length)];
  return JSON.parse(JSON.stringify(rune));
}

function formatRuneStats(stats) {
  const lines = [];

  if (stats.atk) {
    lines.push(`공격력 ${stats.atk > 0 ? '+' : ''}${stats.atk}`);
  }

  if (stats.def) {
    lines.push(`방어력 ${stats.def > 0 ? '+' : ''}${stats.def}`);
  }

  if (stats.critDamage) {
    lines.push(`크리티컬 데미지 +${stats.critDamage}%`);
  }

  if (stats.hpPercent) {
    lines.push(`체력 +${stats.hpPercent}%`);
  }

  return lines.join(' / ');
}

function formatRuneDraw(rune) {
  return [
    `🎲 룬소환석 1개 사용!`,
    ``,
    `획득: ${rune.name}`,
    `효과: ${formatRuneStats(rune.stats)}`,
    ``,
    `⚠️ 룬은 장착 후 해제 시 사라집니다.`,
    `⚠️ 신중하게 사용하세요.`
  ].join('\n');
}

function doRuneDraw(player) {
  if (!player.materials) player.materials = {};
  if (!player.runes) player.runes = [];

  if ((player.materials['룬소환석'] || 0) < 1) {
    return {
      ok: false,
      text: '❌ 룬소환석이 부족합니다.'
    };
  }

  player.materials['룬소환석'] -= 1;

  const rune = drawRune();
  player.runes.push(rune);

  return {
    ok: true,
    rune,
    text: formatRuneDraw(rune)
  };
}

const STAT_CAPS = { critChance: 45, critDamage: 1000, dodge: 30 };

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
  '도살자의 도끼조각', '레오릭왕의 뼈조각', '악마의 정수','악마의 살점', 
  '릴리트의 뿔', '디아블로의 뿔', '고급장비조각','디아블로의 불',
  '천상의 조각','천상석','세계석조각','오염된세계석조각',
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
{ id:'demon_sword', label:'악마의검', type:'weapon', gold:20000,  materials:{ '고급장비조각':20, '악마의 정수':20 }, base:{atk:70,def:0} },
{ id:'lilith_ring', label:'릴리트의 반지', type:'ring', gold:30000,  materials:{ '릴리트의 뿔':20 }, ringRandom:true, base:{atk:0,def:0} },
{ id:'diablo_ring', label:'디아불반지', type:'ring', gold:35000,  materials:{ '디아블로의 불':20 }, ringRandom:true, base:{atk:0,def:0} },
{ id:'end_sword', label:'종말의검', type:'weapon', gold:40000,  materials:{ '디아블로의 뿔':20 }, base:{atk:88,def:0} },

{ id:'corrupted_judgement', label:'오염된 천상의 심판', type:'weapon', gold:50000, materials:{ '오염된세계석조각':5, '고급장비조각':80 }, base:{atk:95,def:15} },
{ id:'corrupted_heaven_armor', label:'오염된 천상의 갑주', type:'armor', gold:50000, materials:{ '오염된세계석조각':5, '고급장비조각':80 }, base:{atk:15,def:80} },

{ id:'lightning_sword', label:'천상의 심판', type:'weapon', gold:100000,  materials:{ '천상의 조각':5, '천상석' :30 },  base:{atk:105,def:30} },
{ id:'lightning_armor', label:'천상의 갑주', type:'armor',  gold:100000, materials:{ '천상의 조각':5, '천상석' :30 }, base:{atk:30,def:105} },


{
  id: 'make_high_frag',
  label: '고급장비조각',
  type: 'material',
  materials: {
    '낡은장비조각': 5
  },
  result: {
    '고급장비조각': 1
  }
},

{
  id: 'make_bless_stone',
  label: '축성석',
  type: 'material',
  materials: {
    '세계석조각': 5
  },
  result: {
    '축성석': 1
  }
}

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

function formatRuneStats(stats) {
  const lines = [];

  if (stats.atk) lines.push(`공격력 ${stats.atk > 0 ? '+' : ''}${stats.atk}`);
  if (stats.def) lines.push(`방어력 ${stats.def > 0 ? '+' : ''}${stats.def}`);
  if (stats.critDamage) lines.push(`크리티컬 데미지 +${stats.critDamage}%`);
  if (stats.hpPercent) lines.push(`체력 +${stats.hpPercent}%`);

  return lines.join(' / ') || '옵션 없음';
}

function getRuneListText(player) {
  if (!player.runes || player.runes.length === 0) {
    return '🎒 보유한 룬이 없습니다.';
  }

  const lines = ['🎒 보유 룬 목록', ''];

  player.runes.forEach((rune, index) => {
    lines.push(`${index + 1}. ${rune.name}`);
    lines.push(`   └ ${formatRuneStats(rune.stats)}`);
  });

  return lines.join('\n');
}

function getEquippedRuneText(player) {
  if (!player.equippedRunes) player.equippedRunes = [null, null, null, null];

  const lines = ['🪄 룬 슬롯', ''];

  player.equippedRunes.forEach((rune, index) => {
    if (!rune) {
      lines.push(`${index + 1}번 슬롯: 비어 있음`);
    } else {
      lines.push(`${index + 1}번 슬롯: ${rune.name}`);
      lines.push(`   └ ${formatRuneStats(rune.stats)}`);
    }
  });

  return lines.join('\n');
}

function findFirstEmptyRuneSlot(player) {
  if (!player.equippedRunes) player.equippedRunes = [null, null, null, null];
  return player.equippedRunes.findIndex(v => v === null);
}

function prepareRuneEquip(player, runeIndex) {
  if (!player.runes) player.runes = [];
  if (!player.equippedRunes) player.equippedRunes = [null, null, null, null];

  if (!Number.isInteger(runeIndex)) {
    return { ok: false, text: '❌ 장착할 룬 번호를 올바르게 입력하세요.' };
  }

  const realIndex = runeIndex - 1;
  const rune = player.runes[realIndex];

  if (!rune) {
    return { ok: false, text: '❌ 해당 번호의 룬이 없습니다.' };
  }

  const emptySlot = findFirstEmptyRuneSlot(player);
  if (emptySlot === -1) {
    return { ok: false, text: '❌ 룬 슬롯이 가득 찼습니다. 먼저 해제하세요.' };
  }

  player.pendingRuneAction = {
    type: 'equip',
    runeIndex: realIndex,
    slotIndex: emptySlot
  };

  return {
    ok: true,
    text: [
      `🪄 ${emptySlot + 1}번 슬롯에 ${rune.name}을(를) 장착합니다.`,
      `효과: ${formatRuneStats(rune.stats)}`,
      ``,
      `⚠️ 장착한 룬은 해제하면 사라집니다.`,
      `정말 장착하시겠습니까?`,
      `확인: !룬장착확인`,
      `취소: !룬취소`
    ].join('\n')
  };
}

function confirmRuneEquip(player) {
  if (!player.pendingRuneAction || player.pendingRuneAction.type !== 'equip') {
    return { ok: false, text: '❌ 진행 중인 룬 장착이 없습니다.' };
  }

  if (!player.runes) player.runes = [];
  if (!player.equippedRunes) player.equippedRunes = [null, null, null, null];

  const { runeIndex, slotIndex } = player.pendingRuneAction;
  const rune = player.runes[runeIndex];

  if (!rune) {
    player.pendingRuneAction = null;
    return { ok: false, text: '❌ 장착할 룬을 찾을 수 없습니다.' };
  }

  if (player.equippedRunes[slotIndex] !== null) {
    player.pendingRuneAction = null;
    return { ok: false, text: '❌ 해당 슬롯이 이미 사용 중입니다.' };
  }

  player.equippedRunes[slotIndex] = rune;
  player.runes.splice(runeIndex, 1);
  player.pendingRuneAction = null;

  return {
    ok: true,
    text: [
      `✅ ${slotIndex + 1}번 슬롯에 ${rune.name} 장착 완료!`,
      `효과: ${formatRuneStats(rune.stats)}`
    ].join('\n')
  };
}

function prepareRuneRemove(player, slotNumber) {
  if (!player.equippedRunes) player.equippedRunes = [null, null, null, null];

  if (!Number.isInteger(slotNumber) || slotNumber < 1 || slotNumber > 4) {
    return { ok: false, text: '❌ 해제할 슬롯 번호는 1~4만 가능합니다.' };
  }

  const slotIndex = slotNumber - 1;
  const rune = player.equippedRunes[slotIndex];

  if (!rune) {
    return { ok: false, text: '❌ 해당 슬롯은 비어 있습니다.' };
  }

  player.pendingRuneAction = {
    type: 'remove',
    slotIndex
  };

  return {
    ok: true,
    text: [
      `🗑 ${slotNumber}번 슬롯의 ${rune.name}을(를) 해제합니다.`,
      `효과: ${formatRuneStats(rune.stats)}`,
      ``,
      `⚠️ 해제한 룬은 복구되지 않고 사라집니다.`,
      `정말 해제하시겠습니까?`,
      `확인: !룬해제확인`,
      `취소: !룬취소`
    ].join('\n')
  };
}

function confirmRuneRemove(player) {
  if (!player.pendingRuneAction || player.pendingRuneAction.type !== 'remove') {
    return { ok: false, text: '❌ 진행 중인 룬 해제가 없습니다.' };
  }

  if (!player.equippedRunes) player.equippedRunes = [null, null, null, null];

  const { slotIndex } = player.pendingRuneAction;
  const rune = player.equippedRunes[slotIndex];

  if (!rune) {
    player.pendingRuneAction = null;
    return { ok: false, text: '❌ 해제할 룬이 없습니다.' };
  }

  player.equippedRunes[slotIndex] = null;
  player.pendingRuneAction = null;

  return {
    ok: true,
    text: `✅ ${slotIndex + 1}번 슬롯의 ${rune.name}을(를) 해제했습니다.\n🗑 룬은 사라졌습니다.`
  };
}

function cancelPendingRuneAction(player) {
  if (!player.pendingRuneAction) {
    return { ok: false, text: '❌ 진행 중인 작업이 없습니다.' };
  }

  player.pendingRuneAction = null;
  return { ok: true, text: '✅ 룬 작업을 취소했습니다.' };
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
    potions: { small:2, mid:1, big:0, elixir:0 },
    materials: blankMaterials(),
    inventory: [],
    runes:[],
    equippedRunes: [null, null, null, null],
    pendingRuneAction: null,
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
  if (!gameData) gameData = {};

  if (!gameData[userId]) {
    gameData[userId] = getDefaultPlayer(userId);
  }

  const player = gameData[userId];

  if (!player.inventory) player.inventory = [];
  if (!player.materials) player.materials = {};
  if (!player.runes) player.runes = [];
  if (!player.equippedRunes) player.equippedRunes = [null, null, null, null];
  if (!player.pendingRuneAction) player.pendingRuneAction = null;

  return player;
}

function formatItemFullText(item) {
  if (!item) return '없음';

  const enhance = item.enhanceLevel ? `+${item.enhanceLevel} ` : '';

  const lines = [];

  // 이름
  lines.push(`${enhance}${item.name}`);

  // 담금질
  if (item.temperCount !== undefined) {
    lines.push(`⚒️ 담금질: ${item.temperCount}/5`);
  }

  // 축성
  if (item.blessing) {
    lines.push(`✨ 축성: ${item.blessing.label}`);
  }

  // 빈 줄
  lines.push('');

  // 스탯
  if (item.atkBonus) lines.push(`⚔️ 공격력 +${item.atkBonus}`);
  if (item.defBonus) lines.push(`🛡️ 방어력 +${item.defBonus}`);
  if (item.critChanceBonus) lines.push(`💥 크확 +${item.critChanceBonus}%`);
  if (item.critDamageBonus) lines.push(`🔥 크뎀 +${item.critDamageBonus}%`);
  if (item.dodgeBonus) lines.push(`💨 회피 +${item.dodgeBonus}%`);

  return lines.join('\n');
}

function formatItemSimpleText(item) {
  if (!item) return '없음';

  const enhanceText = item.enhanceLevel ? `+${item.enhanceLevel} ` : '';
  const blessText = item.blessing ? '✨ ' : '';
  const temperText =
    item.temperCount !== undefined ? `⚒️[${item.temperCount}/5]` : '';

  const statParts = [];
  if (item.atkBonus) statParts.push(`공+${item.atkBonus}`);
  if (item.defBonus) statParts.push(`방+${item.defBonus}`);
  if (item.critChanceBonus) statParts.push(`크확+${item.critChanceBonus}%`);
  if (item.critDamageBonus) statParts.push(`크뎀+${item.critDamageBonus}%`);
  if (item.dodgeBonus) statParts.push(`회+${item.dodgeBonus}%`);

  const statLine = statParts.length ? statParts.join(' ') : '옵션 없음';

  return `${enhanceText}${blessText}${item.name}${temperText}\n${statLine}`;
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

function createRingStats(recipeId) {
  const isLilith = recipeId === 'lilith_ring';
  const isDiablo = recipeId === 'diablo_ring';

  let pool = ['critChanceBonus', 'critDamageBonus', 'dodgeBonus'];
  let countMin = 1;
  let countMax = 3;
  let valueMin = 2;
  let valueMax = 5;

  const out = {
    critChanceBonus: 0,
    critDamageBonus: 0,
    dodgeBonus: 0,
    atkBonus: 0,
    defBonus: 0
  };

  // 릴리트 반지: 크리/회피 쪽 특화, 공격은 조금
  if (isLilith) {
    countMin = 2;
    countMax = 3;
    valueMin = 3;
    valueMax = 6;
  }

  // 디아불 반지: 공격/방어 중심 + 보조 옵션 약간
  if (isDiablo) {
    pool = ['critChanceBonus', 'critDamageBonus', 'dodgeBonus', 'atkBonus', 'defBonus'];
    countMin = 2;
    countMax = 3;
    valueMin = 5;
    valueMax = 8;

    // 디아불 기본 추가 스탯
    out.atkBonus += rand(15, 20);
    out.defBonus += rand(15, 20);
  }

  const count = rand(countMin, countMax);

  const picked = [];
  while (picked.length < count) {
    const k = pick(pool);
    if (!picked.includes(k)) picked.push(k);
  }

  for (const k of picked) {
    out[k] += rand(valueMin, valueMax);
  }

  if (isLilith) {
    out.atkBonus += rand(6, 12);
  }

  return out;
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
  const runeBonus = getRuneBonus(player);
  const setBonus = getRuneSetBonus(player);

  const wb = getBlessingBonuses(player.equipment.weapon);
  const ab = getBlessingBonuses(player.equipment.armor);
  const rb = getBlessingBonuses(player.equipment.ring);

  const totalBlessAtkPercent = wb.atkPercent + ab.atkPercent + rb.atkPercent;
  const totalBlessHpPercent = wb.hpPercent + ab.hpPercent + rb.hpPercent;

  const baseAtk = player.baseAtk + player.stats.atk;
  let atkBeforeBless = baseAtk + eq.atk + runeBonus.atk + setBonus.atk;

  // 불사의 심장 조건부 공격력
  const baseHpWithBless = player.maxHp + Math.floor(player.maxHp * (totalBlessHpPercent / 100));
  const runeHpBonus = Math.floor(baseHpWithBless * (runeBonus.hpPercent / 100));
  const setHpBonus = Math.floor((baseHpWithBless + runeHpBonus) * (setBonus.hpPercent / 100));
  const totalMaxHp = baseHpWithBless + runeHpBonus + setHpBonus;

  if (
    setBonus.lowHpAtkPercent > 0 &&
    setBonus.lowHpThreshold > 0 &&
    totalMaxHp > 0 &&
    (player.hp / totalMaxHp) * 100 <= setBonus.lowHpThreshold
  ) {
    atkBeforeBless += Math.floor(atkBeforeBless * (setBonus.lowHpAtkPercent / 100));
  }

  const blessAtkBonus = Math.floor(atkBeforeBless * (totalBlessAtkPercent / 100));

  return atkBeforeBless + blessAtkBonus;
}
function getMaxHpWithBless(player){
  const wb = getBlessingBonuses(player.equipment.weapon);
  const ab = getBlessingBonuses(player.equipment.armor);
  const rb = getBlessingBonuses(player.equipment.ring);

  const totalBlessHpPercent = wb.hpPercent + ab.hpPercent + rb.hpPercent;
  const blessHpBonus = Math.floor(player.maxHp * (totalBlessHpPercent / 100));

  return player.maxHp + blessHpBonus;
}

function getDefensePower(player){
  const eq = getEquippedBonuses(player);
  const runeBonus = getRuneBonus(player);
  const setBonus = getRuneSetBonus(player);

  const wb = getBlessingBonuses(player.equipment.weapon);
  const ab = getBlessingBonuses(player.equipment.armor);
  const rb = getBlessingBonuses(player.equipment.ring);

  const totalBlessFlatDef = wb.flatDef + ab.flatDef + rb.flatDef;

  const baseDef = player.baseDef + Math.floor(player.level / 3);

  return baseDef + eq.def + totalBlessFlatDef + runeBonus.def + setBonus.def;
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

function grantMaterial(player, name, amount, lines){
  player.materials[name] = (player.materials[name] || 0) + amount;
  lines.push(`📦 ${name} +${amount}`);
}



function formatItemName(item) {
  if (!item) return '알 수 없는 아이템';

  const enhanceText =
    item.enhanceLevel && item.enhanceLevel > 0
      ? `+${item.enhanceLevel} `
      : '';

  return `${enhanceText}${item.name || '이름 없는 아이템'}`;
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
if(['바알','메피스토','디아블로'].includes(monsterName) && chance(40)) {
  drops.push(['악마의 정수', 1]);
}

if(monsterName === '종말의 화신 디아블로' && chance(40)) {
  drops.push(['디아블로의 뿔', 1]);
}

// 🔥 세계석조각 드랍 추가
if(['메피스토','디아블로'].includes(monsterName) && chance(35)) {
  drops.push(['세계석조각', 1]);
}

if(monsterName === '종말의 화신 디아블로' && chance(15)) {
  drops.push(['세계석조각', 1]);
}
if(monsterName === '종말의 화신 디아블로' && chance(35)) {
  drops.push(['디아블로의 불', 1]);
}
if(monsterName === '디아블로' && chance(30)) {
  drops.push(['디아블로의 불', 1]);
}
const uberHellSet = [
  '우버 레오릭 왕',
  '우버 안다리엘',
  '우버 두리엘',
  '우버 바알',
  '우버 디아블로',
  '우버 메피스토',
  '우버 릴리트',
  '우버 종말의 화신 디아블로'
];

if (uberHellSet.includes(monsterName)) {
  if (chance(35)) drops.push(['오염된세계석조각', 1]);
  if (chance(50)) drops.push(['고급장비조각', 1]);
}



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

  const goldCosts = [100, 150, 250, 400, 700, 1000, 1500, 3000, 5000, 10000];
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

  const eq = getEquippedBonuses(player);
  const runeBonus = getRuneBonus(player);
  const setBonus = getRuneSetBonus(player);

  const wb = getBlessingBonuses(player.equipment.weapon);
  const ab = getBlessingBonuses(player.equipment.armor);
  const rb = getBlessingBonuses(player.equipment.ring);

  const totalBlessFlatDef = wb.flatDef + ab.flatDef + rb.flatDef;
  const totalBlessDodge = wb.dodge + ab.dodge + rb.dodge;
  const totalBlessReflect = wb.reflect + ab.reflect + rb.reflect;

  const baseDef = player.baseDef + Math.floor(player.level / 3);
  const finalDef = baseDef + eq.def + totalBlessFlatDef + runeBonus.def + setBonus.def;

  const finalDodge = Math.min(
    STAT_CAPS.dodge,
    player.stats.dodge + eq.dodge + totalBlessDodge
  );

  if (chance(finalDodge)) {
    logs.push(makeDodgeLine());
    return;
  }

  let dmg = Math.max(1, target.atk - finalDef);

  // 철벽 수호 피해감소 15%
  if (setBonus.damageReduce > 0) {
    dmg = Math.max(1, Math.floor(dmg * (1 - setBonus.damageReduce / 100)));
  }

  player.hp -= dmg;
  logs.push(makeEnemyDamageLine(target.name, dmg));

  if (totalBlessReflect > 0 && dmg > 0 && target.currentHp > 0) {
    const reflectDmg = Math.floor(dmg * (totalBlessReflect / 100));

    if (reflectDmg > 0) {
      target.currentHp = Math.max(0, target.currentHp - reflectDmg);
      logs.push(`🔁 데미지반사 ${reflectDmg}`);
    }
  }

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

  const maxHp = getMaxHpWithBless(player);

  player.potions[key] -= 1;
  player.hp = Math.min(maxHp, player.hp + item.heal);

  return `${item.label} 사용! HP ${player.hp}/${maxHp}`;
}

function usePotionInBattle(player, key){
  const item = SHOP[key];
  if(!item) return { logs:['잘못된 물약입니다.'] };
  if((player.potions[key]||0) <= 0) return { logs:[`${item.label}이 없습니다.`] };
  if(!player.run?.target) return { logs:['현재 전투 중인 몬스터가 없습니다.'] };
  if(player.run.isDown) return { logs:['쓰러진 상태입니다. 먼저 부활권을 사용하세요.'] };

  const maxHp = getMaxHpWithBless(player);

  player.potions[key] -= 1;
  player.hp = Math.min(maxHp, player.hp + item.heal);

  const logs = [`${item.label} 사용! HP ${player.hp}/${maxHp}`];
  enemyAttack(player, player.run.target, logs);
  return { logs };
}

function performAttack(player, dungeonKey){
  const result = { logs:[], killedTarget:null, levelUps:[], clearedDungeon:false };

  const revived = reviveIfRespawnReady(player);
  if(revived) result.logs.push('✨ 부활 시간이 지나 자동으로 부활했습니다.');

  createRunIfNeeded(player, dungeonKey);

  if(player.run.isDown){
    result.logs.push('쓰러진 상태입니다. 먼저 부활권을 사용하거나 부활 시간을 기다리세요.');
    return result;
  }

  if(!player.run.target){
    if(player.run.nextTarget){
      player.run.target = player.run.nextTarget;
      player.run.nextTarget = null;
      result.logs.push(`✨ 다음 몬스터 매칭: ${player.run.target.name}`);
      return result;
    }
    result.logs.push('현재 매칭 가능한 몬스터가 없습니다.');
    return result;
  }

  const target = player.run.target;

  const eq = getEquippedBonuses(player);
  const runeBonus = getRuneBonus(player);
  const setBonus = getRuneSetBonus(player);

  const wb = getBlessingBonuses(player.equipment.weapon);
  const ab = getBlessingBonuses(player.equipment.armor);
  const rb = getBlessingBonuses(player.equipment.ring);

  const totalBlessAtkPercent = wb.atkPercent + ab.atkPercent + rb.atkPercent;
  const totalBlessCritChance = wb.critChance + ab.critChance + rb.critChance;
  const totalBlessCritDamage = wb.critDamage + ab.critDamage + rb.critDamage;
  const totalBlessLifesteal = wb.lifesteal + ab.lifesteal + rb.lifesteal;
  const totalBlessHpPercent = wb.hpPercent + ab.hpPercent + rb.hpPercent;

  const baseAtk = player.baseAtk + player.stats.atk;
  let atkBeforeBless = baseAtk + eq.atk + runeBonus.atk + setBonus.atk;

  const baseHpWithBless = player.maxHp + Math.floor(player.maxHp * (totalBlessHpPercent / 100));
  const runeHpBonus = Math.floor(baseHpWithBless * (runeBonus.hpPercent / 100));
  const setHpBonus = Math.floor((baseHpWithBless + runeHpBonus) * (setBonus.hpPercent / 100));
  const totalMaxHp = baseHpWithBless + runeHpBonus + setHpBonus;

  // 불사의 심장: 체력 30% 이하 공격력 +20%
  if (
    setBonus.lowHpAtkPercent > 0 &&
    setBonus.lowHpThreshold > 0 &&
    totalMaxHp > 0 &&
    (player.hp / totalMaxHp) * 100 <= setBonus.lowHpThreshold
  ) {
    const lowHpBonus = Math.floor(atkBeforeBless * (setBonus.lowHpAtkPercent / 100));
    atkBeforeBless += lowHpBonus;
    result.logs.push(`🔥 저체력 버프 +${lowHpBonus}`);
  }

  const blessAtkBonus = Math.floor(atkBeforeBless * (totalBlessAtkPercent / 100));
  const finalAtk = atkBeforeBless + blessAtkBonus;

  // 치명 폭발: 기본/장비/축성은 45% 캡, 조합은 캡 위로 추가
  const baseCritChance = player.stats.critChance + eq.critChance + totalBlessCritChance;
  const finalCritChance = Math.min(STAT_CAPS.critChance, baseCritChance) + (setBonus.critChance || 0);

  const finalCritDamage = Math.min(
    STAT_CAPS.critDamage,
    player.stats.critDamage + eq.critDamage + totalBlessCritDamage + runeBonus.critDamage + setBonus.critDamage
  );

  let damage = finalAtk - target.def;
  let isCrit = false;

  if (chance(finalCritChance)) {
    damage *= 1.5 + (finalCritDamage / 100);
    isCrit = true;
  }

  damage = Math.max(1, Math.floor(damage));

  target.currentHp -= damage;
  result.logs.push(makeDamageLine('👤 플레이어', target.name, damage, isCrit));

  // 광기의 연격: 추가타 30%, 추가타도 크리 가능
  if (
    target.currentHp > 0 &&
    setBonus.extraHitChance > 0 &&
    chance(setBonus.extraHitChance)
  ) {
    let extraDamage = Math.max(1, Math.floor(damage * (setBonus.extraHitDamageRate || 0.5)));
    let extraCrit = false;

    if (chance(finalCritChance)) {
      extraDamage = Math.floor(extraDamage * (1.5 + finalCritDamage / 100));
      extraCrit = true;
    }

    target.currentHp -= extraDamage;
    result.logs.push(extraCrit ? `⚡ 추가타 치명타! ${extraDamage}` : `⚡ 추가타 ${extraDamage}`);
  }

  // 흡혈 적용
  const totalLifesteal = totalBlessLifesteal + setBonus.lifesteal;
  if (totalLifesteal > 0 && damage > 0) {
    const heal = Math.floor(damage * (totalLifesteal / 100));
    const beforeHp = player.hp;

    player.hp = Math.min(totalMaxHp, player.hp + heal);

    const actualHeal = player.hp - beforeHp;
    if (actualHeal > 0) result.logs.push(`🩸 흡혈 +${actualHeal}`);
  }

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
    player.run.target = null;

    if(dungeon.type === 'random'){
      endBattle(player);
      result.logs.push('🏘️ 전투 종료! 이제 마을 기능을 사용할 수 있습니다.');
      return result;
    }

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

  // 🔥 골드 체크 추가
  if ((player.gold || 0) < (recipe.gold || 0)) return false;

  return true;
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
  };

  // 🔥 무기/방어구 랜덤 옵션
  if (recipe.type === 'weapon' || recipe.type === 'armor') {
    const randomOptions = createRandomOptionsByRarity(rarity.key);

    item.atkBonus += randomOptions.atkBonus;
    item.defBonus += randomOptions.defBonus;
    item.critChanceBonus += randomOptions.critChanceBonus;
    item.critDamageBonus += randomOptions.critDamageBonus;
    item.dodgeBonus += randomOptions.dodgeBonus;
  }

  // 반지 랜덤
  if (recipe.ringRandom) {
    Object.assign(item, createRingStats(recipe.id));
  }

  return item;
}

function tryCraft(player, craftId){
  const recipe = CRAFT_BY_ID[craftId];
  if(!recipe) return { ok:false, text:'없는 제작식입니다.' };

  if(!canCraft(player, recipe)){
    return { ok:false, text:'❌ 재료 또는 골드가 부족합니다.' };
  }

  const needGold = recipe.gold || 0;

  // 🔥 재료 차감
  for(const [mat, need] of Object.entries(recipe.materials)){
    player.materials[mat] -= need;
  }

  // 🔥 골드 차감
  player.gold -= needGold;

  // 🔥 재료 제작
  if (recipe.type === 'material') {
    if (!player.materials) player.materials = {};

    for (const [mat, amount] of Object.entries(recipe.result || {})) {
      player.materials[mat] = (player.materials[mat] || 0) + amount;
    }

    const madeText = Object.entries(recipe.result || {})
      .map(([mat, amount]) => `${mat} ${amount}개`)
      .join(', ');

    return { 
      ok:true, 
      text:`🛠️ 제작 성공!\n${madeText}${needGold ? ` (-${needGold}G)` : ''}` 
    };
  }

  // 🔥 장비 제작
  const item = createCraftItem(recipe);
  player.inventory.push(item);

  return { 
    ok:true, 
    item, 
    text:`🛠️ 제작 성공!\n${formatItemName(item)}${needGold ? ` (-${needGold}G)` : ''}` 
  };
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

  const goldCosts = [100, 150, 250, 400, 700, 1000, 1500, 3000, 5000, 10000];
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
      const candidates = stats.filter(k => (item[k] || 0) >= 1);

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
  const weaponText = player.equipment.weapon
    ? `+${player.equipment.weapon.enhanceLevel || 0}${player.equipment.weapon.blessing ? ' (축성)' : ''} ${player.equipment.weapon.name}[담금질${player.equipment.weapon.temperCount || 0}/5]\n${getItemStatTextWithBless(player.equipment.weapon) || '(스탯없음)'}`
    : '없음';

  const armorText = player.equipment.armor
    ? `+${player.equipment.armor.enhanceLevel || 0}${player.equipment.armor.blessing ? ' (축성)' : ''} ${player.equipment.armor.name}[담금질${player.equipment.armor.temperCount || 0}/5]\n${getItemStatTextWithBless(player.equipment.armor) || '(스탯없음)'}`
    : '없음';

  const ringText = player.equipment.ring
    ? `+${player.equipment.ring.enhanceLevel || 0}${player.equipment.ring.blessing ? ' (축성)' : ''} ${player.equipment.ring.name}[담금질${player.equipment.ring.temperCount || 0}/5]\n${getItemStatTextWithBless(player.equipment.ring) || '(스탯없음)'}`
    : '없음';

  return [
    `⚔️ 무기: ${weaponText}`,
    `🛡️ 갑옷: ${armorText}`,
    `💍 반지: ${ringText}`
  ].join('\n\n');
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
    .map((it, idx) => `${start + idx + 1}. ${formatItemName(it)} [${it.type}]`)
    .join('\n');
}

function getEquippedText(player){
  const w = player.equipment?.weapon;
  const a = player.equipment?.armor;
  const r = player.equipment?.ring;

  return [
    `⚔️ 무기: ${formatItemSimpleText(w)}`,
    `🛡️ 방어구: ${formatItemSimpleText(a)}`,
    `💍 반지: ${formatItemSimpleText(r)}`
  ].join('\n\n');
}

function buildFullStatusText(player){
  const eq = getEquippedBonuses(player);
  const runeBonus = getRuneBonus(player);
  const setBonus = getRuneSetBonus(player);

  const wb = getBlessingBonuses(player.equipment.weapon);
  const ab = getBlessingBonuses(player.equipment.armor);
  const rb = getBlessingBonuses(player.equipment.ring);

  const totalBlessAtkPercent = wb.atkPercent + ab.atkPercent + rb.atkPercent;
  const totalBlessCritChance = wb.critChance + ab.critChance + rb.critChance;
  const totalBlessCritDamage = wb.critDamage + ab.critDamage + rb.critDamage;
  const totalBlessLifesteal = wb.lifesteal + ab.lifesteal + rb.lifesteal;

  const totalBlessFlatDef = wb.flatDef + ab.flatDef + rb.flatDef;
  const totalBlessDodge = wb.dodge + ab.dodge + rb.dodge;
  const totalBlessHpPercent = wb.hpPercent + ab.hpPercent + rb.hpPercent;
  const totalBlessReflect = wb.reflect + ab.reflect + rb.reflect;

  const baseAtk = player.baseAtk + player.stats.atk;
  let atkBeforeBless = baseAtk + eq.atk + runeBonus.atk + setBonus.atk;


  // 불사의 심장 조건부 공격력
  const baseHpWithBless = player.maxHp + Math.floor(player.maxHp * (totalBlessHpPercent / 100));
  const runeHpBonus = Math.floor(baseHpWithBless * (runeBonus.hpPercent / 100));
  const setHpBonus = Math.floor((baseHpWithBless + runeHpBonus) * (setBonus.hpPercent / 100));
  const totalMaxHp = baseHpWithBless + runeHpBonus + setHpBonus;

  if (
    setBonus.lowHpAtkPercent > 0 &&
    setBonus.lowHpThreshold > 0 &&
    totalMaxHp > 0 &&
    (player.hp / totalMaxHp) * 100 <= setBonus.lowHpThreshold
  ) {
    atkBeforeBless += Math.floor(atkBeforeBless * (setBonus.lowHpAtkPercent / 100));
  }

  const blessAtkBonus = Math.floor(atkBeforeBless * (totalBlessAtkPercent / 100));
  const totalAtk = atkBeforeBless + blessAtkBonus;

  const baseDef = player.baseDef + Math.floor(player.level / 3);
  const totalDef = baseDef + eq.def + totalBlessFlatDef + runeBonus.def + setBonus.def;

  const baseCrit = player.stats.critChance;
  const cappedCrit = Math.min(
    STAT_CAPS.critChance,
    baseCrit + eq.critChance + totalBlessCritChance
  );
  const totalCrit = cappedCrit + setBonus.critChance; // 전설 조합은 cap 위로 추가

  const baseCritDmg = player.stats.critDamage;
  const totalCritDmg = Math.min(
    STAT_CAPS.critDamage,
    baseCritDmg + eq.critDamage + totalBlessCritDamage + runeBonus.critDamage + setBonus.critDamage
  );

  const baseDodge = player.stats.dodge;
  const totalDodge = Math.min(
    STAT_CAPS.dodge,
    baseDodge + eq.dodge + totalBlessDodge
  );

  const blessHpBonus = totalMaxHp - player.maxHp;
  const buildStatDetail = (parts) => parts.filter(Boolean).join(' + ');
const hpDetail = buildStatDetail([
  `기본 ${player.maxHp}`,
  blessHpBonus ? `축성/룬/조합 ${blessHpBonus}` : null
]);

const atkDetail = buildStatDetail([
  `기본 ${baseAtk}`,
  eq.atk ? `장비 ${eq.atk}` : null,
  runeBonus.atk ? `룬 ${runeBonus.atk}` : null,
  setBonus.atk ? `조합 ${setBonus.atk}` : null,
  blessAtkBonus ? `축성 ${blessAtkBonus}` : null
]);

const defDetail = buildStatDetail([
  `기본 ${baseDef}`,
  eq.def ? `장비 ${eq.def}` : null,
  runeBonus.def ? `룬 ${runeBonus.def}` : null,
  setBonus.def ? `조합 ${setBonus.def}` : null,
  totalBlessFlatDef ? `축성 ${totalBlessFlatDef}` : null
]);

const critDetail = buildStatDetail([
  `기본 ${baseCrit}%`,
  eq.critChance ? `장비 ${eq.critChance}%` : null,
  totalBlessCritChance ? `축성 ${totalBlessCritChance}%` : null,
  setBonus.critChance ? `조합 ${setBonus.critChance}%` : null
]);

const critDmgDetail = buildStatDetail([
  `기본 ${baseCritDmg}%`,
  eq.critDamage ? `장비 ${eq.critDamage}%` : null,
  runeBonus.critDamage ? `룬 ${runeBonus.critDamage}%` : null,
  setBonus.critDamage ? `조합 ${setBonus.critDamage}%` : null,
  totalBlessCritDamage ? `축성 ${totalBlessCritDamage}%` : null
]);

const dodgeDetail = buildStatDetail([
  `기본 ${baseDodge}%`,
  eq.dodge ? `장비 ${eq.dodge}%` : null,
  totalBlessDodge ? `축성 ${totalBlessDodge}%` : null
]);


  return [
    `🏷️ 레벨: ${player.level} (${player.xp}/${player.nextXp})`,
    `🎯 스탯포인트: ${player.statPoints}`,
    '',
`❤️ HP: ${player.hp}/${totalMaxHp} (${hpDetail})`,
`⚔️ 공격력: ${totalAtk} (${atkDetail})`,
`🛡️ 방어력: ${totalDef} (${defDetail})`,
`💥 크리확률: ${totalCrit}% (${critDetail})`,
`🔥 크리데미지: +${totalCritDmg}% (${critDmgDetail})`,
`💨 회피: ${totalDodge}% (${dodgeDetail})`,
    `🩸 흡혈: ${totalBlessLifesteal + setBonus.lifesteal}%`,
    `🔁 데미지반사: ${totalBlessReflect}%`,
    '',
    `📦 장착 장비`,
    getEquippedText(player),
    '',
    `🔮 장착 룬`,
    getEquippedRuneStatusText(player),
    '',
    `✨ 룬 조합 효과`,
    getRuneSetText(player)
  ].join('\n');
}

function buildBagText(player){
  const mats = Object.entries(player.materials || {})
    .filter(([,v]) => v > 0)
    .map(([k,v]) => `${k} ${v}`)
    .join(' / ') || '없음';

  const items = player.inventory && player.inventory.length
    ? player.inventory.slice(0, 15).map((it, idx) =>
        `${idx + 1}. ${formatItemName(it)} [${it.type}]`
      ).join('\n')
    : '비어있음';

  return [
    `💰 골드: ${player.gold}`,
    `💖 부활권: ${player.reviveTickets}`,
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
    lines.push('━━━━━━━━━━');
  } else {
    lines.push('👿 몬스터 없음');
    lines.push('━━━━━━━━━━');
  }

  const runeBonus = getRuneBonus(player);
  const setBonus = getRuneSetBonus(player);

  const wb = getBlessingBonuses(player.equipment.weapon);
  const ab = getBlessingBonuses(player.equipment.armor);
  const rb = getBlessingBonuses(player.equipment.ring);
  const totalBlessHpPercent = wb.hpPercent + ab.hpPercent + rb.hpPercent;

  const baseHpWithBless = player.maxHp + Math.floor(player.maxHp * (totalBlessHpPercent / 100));
  const runeHpBonus = Math.floor(baseHpWithBless * (runeBonus.hpPercent / 100));
  const setHpBonus = Math.floor((baseHpWithBless + runeHpBonus) * (setBonus.hpPercent / 100));
  const maxHp = baseHpWithBless + runeHpBonus + setHpBonus;

  if (player.hp > maxHp) player.hp = maxHp;

  lines.push(`<#${channelId}>`);
  lines.push(`❤️ ${player.hp}/${maxHp}`);
  lines.push(`⚔️ ${getAttackPower(player)} / 🛡️ ${getDefensePower(player)}`);

  if (setBonus.name) {
    lines.push(`✨ ${setBonus.name}`);
  }

  lines.push(
    `💊 ${player.potions.small || 0} / 🍗 ${player.potions.mid || 0} / 🍖 ${player.potions.big || 0} / 🥩 ${player.potions.large || 0} / 🍖🍖 ${player.potions.huge || 0} / 🧪 ${player.potions.elixir || 0}`
  );

  return lines.join('\n');
}

function getItemStatText(item) {
  if (!item) return '';

  const parts = [];

  if (item.atkBonus) parts.push(`공+${item.atkBonus}`);
  if (item.defBonus) parts.push(`방+${item.defBonus}`);
  if (item.critChanceBonus) parts.push(`크확+${item.critChanceBonus}%`);
  if (item.critDamageBonus) parts.push(`크뎀+${item.critDamageBonus}%`);
  if (item.dodgeBonus) parts.push(`회피+${item.dodgeBonus}%`);
  if (item.hpBonus) parts.push(`HP+${item.hpBonus}`);
  if (item.hpPercentBonus) parts.push(`HP+${item.hpPercentBonus}%`);

  return parts.length ? ` (${parts.join(', ')})` : '';
}

function formatItemName(item) {
  if (!item) return '알 수 없는 아이템';

  const enhanceText =
    item.enhanceLevel && item.enhanceLevel > 0
      ? `+${item.enhanceLevel} `
      : '';

  return `${enhanceText}${item.name || '이름 없는 아이템'}${getItemStatText(item)}`;
}

function getItemStatTextWithBless(item){
  if (!item) return '';

  const parts = [];

  if ((item.atkBonus || 0) > 0) parts.push(`공+${item.atkBonus}`);
  if ((item.defBonus || 0) > 0) parts.push(`방+${item.defBonus}`);
  if ((item.critChanceBonus || 0) > 0) parts.push(`크리+${item.critChanceBonus}%`);
  if ((item.critDamageBonus || 0) > 0) parts.push(`크뎀+${item.critDamageBonus}%`);
  if ((item.dodgeBonus || 0) > 0) parts.push(`회피+${item.dodgeBonus}%`);

  return parts.length ? `(${parts.join(' ')})` : '';
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
      new ButtonBuilder().setCustomId('enhance_menu').setLabel('🔨 강화').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('equipment_view').setLabel('🧰 장비').setStyle(ButtonStyle.Primary),
   ),
  ];
}

function buildEnhanceMenuButtons(player){
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('enhance_select')
        .setLabel('강화')
        .setStyle(ButtonStyle.Primary),

      new ButtonBuilder()
        .setCustomId('temper_select')
        .setLabel('담금질')
        .setStyle(ButtonStyle.Secondary),

      new ButtonBuilder()
        .setCustomId('bless_select')
        .setLabel('축성')
        .setStyle(ButtonStyle.Success),
    )
  ];
}

function buildTemperButtons(player){
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('temper_weapon')
        .setLabel('⚔️ 무기')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(!player.equipment?.weapon),

      new ButtonBuilder()
        .setCustomId('temper_armor')
        .setLabel('🛡️ 갑옷')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(!player.equipment?.armor),

      new ButtonBuilder()
        .setCustomId('temper_ring')
        .setLabel('💍 반지')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(!player.equipment?.ring),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('enhance_menu')
        .setLabel('↩️ 뒤로')
        .setStyle(ButtonStyle.Secondary),
    )
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
      new ButtonBuilder().setCustomId('attack_1').setLabel('⚔️ 1타').setStyle(ButtonStyle.Danger).setDisabled(down),
      new ButtonBuilder().setCustomId('attack_3').setLabel('⚔️ 3타').setStyle(ButtonStyle.Danger).setDisabled(down),
      new ButtonBuilder().setCustomId('attack_5').setLabel('⚔️ 5타').setStyle(ButtonStyle.Danger).setDisabled(down),
      new ButtonBuilder().setCustomId('status').setLabel('📋 상태창').setStyle(ButtonStyle.Primary),
    ),

    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('use_small').setLabel('💊').setStyle(ButtonStyle.Secondary).setDisabled(down),
      new ButtonBuilder().setCustomId('use_mid').setLabel('🍗').setStyle(ButtonStyle.Secondary).setDisabled(down),
      new ButtonBuilder().setCustomId('use_big').setLabel('🍖').setStyle(ButtonStyle.Secondary).setDisabled(down),
      new ButtonBuilder().setCustomId('auto').setLabel(canAuto ? '🤖 자동' : '자동불가').setStyle(canAuto ? ButtonStyle.Success : ButtonStyle.Secondary).setDisabled(!canAuto || down),
    ),

    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('use_large').setLabel('🥩').setStyle(ButtonStyle.Secondary).setDisabled(down),
      new ButtonBuilder().setCustomId('use_huge').setLabel('🍖🍖').setStyle(ButtonStyle.Secondary).setDisabled(down),
      new ButtonBuilder().setCustomId('use_elixir').setLabel('🧪').setStyle(ButtonStyle.Secondary).setDisabled(down),
      new ButtonBuilder().setCustomId('revive').setLabel('💖 부활권').setStyle(ButtonStyle.Success).setDisabled(!down || player.reviveTickets <= 0),
    ),
  ];
}

function getEquippedRuneStatusText(player) {
  if (!player.equippedRunes) {
    player.equippedRunes = [null, null, null, null];
  }

  return player.equippedRunes.map((rune, index) => {
    if (!rune) return `${index + 1}번 슬롯: 비어 있음`;

    return `${index + 1}번 슬롯: ${rune.name} (${formatRuneStats(rune.stats)})`;
  }).join('\n');
}

function buildStatusButtons(player){
  const noPoints = player.statPoints <= 0;

  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('stat_atk').setLabel('⚔️ 공격 +').setStyle(ButtonStyle.Danger).setDisabled(noPoints),
      new ButtonBuilder().setCustomId('stat_crit').setLabel('💥 크리 +').setStyle(ButtonStyle.Primary).setDisabled(noPoints || getCritChance(player) >= STAT_CAPS.critChance),
      new ButtonBuilder().setCustomId('stat_critdmg').setLabel('🔥 크뎀 +').setStyle(ButtonStyle.Primary).setDisabled(noPoints || getCritDamage(player) >= STAT_CAPS.critDamage),
      new ButtonBuilder().setCustomId('stat_dodge').setLabel('💨 회피 +').setStyle(ButtonStyle.Success).setDisabled(noPoints || getDodge(player) >= STAT_CAPS.dodge)
    ),

    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('rune_draw').setLabel('🎲 룬뽑기').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('rune_equip_menu').setLabel('룬장착').setStyle(ButtonStyle.Primary)
    )
  ];
}


function buildShopButtons(){
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('buy_small').setLabel('💊 10G').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('buy_mid').setLabel('🍗 30G').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('buy_big').setLabel('🍖 100G').setStyle(ButtonStyle.Secondary),
    ),

    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('buy_large').setLabel('🥩 500G').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('buy_huge').setLabel('🍖🍖 1000G').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('buy_elixir').setLabel('🧪 3000G').setStyle(ButtonStyle.Secondary),
    ),

    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('buy_big_10').setLabel('🍖×10 (1000G)').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('buy_large_10').setLabel('🥩×10 (5000G)').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('buy_huge_10').setLabel('🍖🍖×10 (10000G)').setStyle(ButtonStyle.Secondary),
    ),

    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('buy_advanced_part').setLabel('🧩 5000G').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('buy_advanced_part_10').setLabel('🧩×10 (50000G)').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('buy_rune_stone').setLabel('🌠 (300000G)').setStyle(ButtonStyle.Secondary),
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
      new ButtonBuilder().setCustomId('craft_cat_material').setLabel('📦 재료').setStyle(ButtonStyle.Secondary),
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

  if (player.equipment?.weapon) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('enhance_equipped_weapon')
          .setLabel(`⚔️ 착용 무기`.slice(0, 80))
          .setStyle(ButtonStyle.Danger)
      )
    );
  }

  if (player.equipment?.armor) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('enhance_equipped_armor')
          .setLabel(`🛡️ 착용 갑옷`.slice(0, 80))
          .setStyle(ButtonStyle.Primary)
      )
    );
  }

  if (player.equipment?.ring) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('enhance_equipped_ring')
          .setLabel(`💍 착용 반지`.slice(0, 80))
          .setStyle(ButtonStyle.Success)
      )
    );
  }

  const inventoryItems = (player.inventory || [])
    .map((item, idx) => ({ item, idx }))
    .filter(({ item }) => item && ['weapon', 'armor', 'ring'].includes(item.type));

  for (let i = 0; i < inventoryItems.length; i += 5) {
    if (rows.length >= 5) break; // 🔥 최대 5줄 제한

    const chunk = inventoryItems.slice(i, i + 5);
    if (!chunk.length) continue;

    rows.push(
      new ActionRowBuilder().addComponents(
        ...chunk.map(({ item, idx }) =>
          new ButtonBuilder()
            .setCustomId(`enhance_item_${idx}`)
            .setLabel(`${item.name}${getEnhanceLevelText(item)}`.slice(0, 80))
            .setStyle(ButtonStyle.Secondary)
        )
      )
    );
  }

  return rows;
}

function buildIntroPayload(dungeonKey, target){
  if(!target){
    return { embeds:[new EmbedBuilder().setTitle('⚠️ 몬스터 없음').setDescription('현재 표시할 몬스터가 없습니다.').setColor(0x555555)] };
  }
  const embed = new EmbedBuilder()
    .setTitle(`👁️ ${target.name} 등장`)
    .setDescription(`던전: ${DISPLAY_NAMES[dungeonKey]}`)
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
  await safeSave(player);

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




client.on('messageCreate', async (message) => {
  console.log('메시지 받음:', message.content, message.channel.id);

  if (message.author.bot) return;
  if (!message.content.startsWith('!')) return;

  const player = getPlayer(message.author.id);
  const args = message.content.trim().split(/\s+/);
  const command = args[0];
  const arg = args[1];

  if (command === '!판매') {
    if (!player.materials) player.materials = {};

    if (args.length < 3) {
      await message.reply('사용법: !판매 재료이름 갯수');
      return;
    }

    const amount = Number(args[args.length - 1]);
    const matName = args.slice(1, -1).join(' ').trim();

    if (!matName || Number.isNaN(amount) || amount <= 0) {
      await message.reply('사용법: !판매 재료이름 갯수');
      return;
    }

    const unitPrice = MATERIAL_PRICES[matName];
    if (!unitPrice) {
      await message.reply(`❌ ${matName}은(는) 판매 불가`);
      return;
    }

    const have = player.materials[matName] || 0;
    if (have < amount) {
      await message.reply(`❌ ${matName} 부족 (${have}개 보유)`);
      return;
    }

    const total = unitPrice * amount;

    player.materials[matName] -= amount;
    player.gold += total;

    await safeSave(player);

    await message.reply(`💰 ${matName} ${amount}개 판매 (+${total}G)`);
    return;
  }




if(command === '!가방'){
    console.log("📦 !가방 분기 들어옴");
    await safeSave(player);
    await message.reply({ content: buildBagText(player) });
    return;
}

  if(command === '!도움말'){
    await message.reply(formatHelp());
    return;
  }


if (command === '!스탯초기화') {
  if (!isAdmin(message)) {
    await message.reply('❌ 관리자만 사용 가능합니다.');
    return;
  }

  const target = message.mentions.users.first();
  if (!target) {
    await message.reply('사용법: !스탯초기화 @유저');
    return;
  }

  const targetPlayer = getPlayer(target.id);

  if (!targetPlayer.stats) targetPlayer.stats = {};

  targetPlayer.stats.atk = 0;
  targetPlayer.stats.critChance = 0;
  targetPlayer.stats.critDamage = 0;
  targetPlayer.stats.dodge = 0;

  // 스탯포인트도 같이 초기화하고 싶으면 적당히 지급
  // 필요하면 여기 숫자 계산 방식은 나중에 바꿔도 됨
targetPlayer.statPoints = (targetPlayer.level || 1) * 3;

  await safeSave(player);
  await message.reply(`✅ ${target.username}의 스탯을 초기화했습니다.`);
  return;
}

if (command === '!재료주기') {
  if (!isAdmin(message)) {
    await message.reply('❌ 관리자만 사용 가능합니다.');
    return;
  }

  const target = message.mentions.users.first();
  if (!target) {
    await message.reply('사용법: !재료주기 @유저 재료이름 수량');
    return;
  }

  const targetPlayer = getPlayer(target.id);
  if (!targetPlayer.materials) targetPlayer.materials = {};

  const args = message.content.trim().split(/\s+/);

  if (args.length < 4) {
    await message.reply('사용법: !재료주기 @유저 재료이름 수량');
    return;
  }

  const amount = Number(args[args.length - 1]);
  const matName = args.slice(2, -1).join(' ').trim();

  if (!matName || isNaN(amount) || amount <= 0) {
    await message.reply('사용법: !재료주기 @유저 재료이름 수량');
    return;
  }

  targetPlayer.materials[matName] = (targetPlayer.materials[matName] || 0) + amount;

  await safeSave(player);
  await message.reply(`✅ ${target.username}에게 ${matName} ${amount}개를 지급했습니다.`);
  return;
}

if (command === '!아이템지급') {
  if (!isAdmin(message)) return;

  const target = message.mentions.users.first();
  if (!target) {
    await message.reply('유저 멘션 필요');
    return;
  }

  const args = message.content.trim().split(/\s+/);
  const kind = args[2];

  if (!kind) {
    await message.reply('종류: 검 / 갑옷 / 링 / 세트 / 부활권 / 룬소환석');
    return;
  }

  const player = getPlayer(target.id);

  // 🔥 부활권 단독 지급
  if (kind === '부활권') {
    const amount = Number(args[3]) || 1;

    player.reviveTickets = (player.reviveTickets || 0) + amount;

    await safeSave(player);

    await message.reply(
      `💖 ${target.username}에게 부활권 ${amount}개 지급 완료 (현재 ${player.reviveTickets}개)`
    );
    return;
  }

  // 🔥 룬소환석 단독 지급
  if (kind === '룬소환석') {
    const amount = Number(args[3]) || 1;

    if (!player.materials) player.materials = {};
    player.materials['룬소환석'] = (player.materials['룬소환석'] || 0) + amount;

    await safeSave(player);

    await message.reply(
      `🌠 ${target.username}에게 룬소환석 ${amount}개 지급 완료 (현재 ${player.materials['룬소환석']}개)`
    );
    return;
  }

  // 🔥 세트 지급
  if (kind === '세트') {
    const sword = {
      name: '🔥 짭버검',
      type: 'weapon',
      rarity: 'legendary',
      rarityLabel: '전설',
      atkBonus: 128,
      defBonus: 4,
      critChanceBonus: 4,
      critDamageBonus: 0,
      dodgeBonus: 0,
      enhanceLevel: 9,
      temperCount: 5,
      blessing: { key: 'lifesteal', label: '흡혈 15%', value: 15 }
    };

    const armor = {
      name: '🔥 짭버갑',
      type: 'armor',
      rarity: 'legendary',
      rarityLabel: '전설',
      atkBonus: 11,
      defBonus: 110,
      critChanceBonus: 8,
      critDamageBonus: 0,
      dodgeBonus: 7,
      enhanceLevel: 9,
      temperCount: 5,
      blessing: { key: 'reflect', label: '데미지반사 15%', value: 15 }
    };

    const ring = {
      name: '🔥 짭반',
      type: 'ring',
      rarity: 'legendary',
      rarityLabel: '전설',
      atkBonus: 29,
      defBonus: 25,
      critChanceBonus: 18,
      critDamageBonus: 25,
      dodgeBonus: 30,
      enhanceLevel: 9,
      temperCount: 5
    };

    player.inventory.push(sword, armor, ring);

    player.reviveTickets = (player.reviveTickets || 0) + 10;

    await safeSave(player);

    await message.reply(
      `🔥 ${target.username}에게 절대세트 + 부활권 10개 지급 완료`
    );
    return;
  }

  // 🔥 개별 장비 지급
  let item;

  if (kind === '검') {
    item = {
      name: '🔥 절대검',
      type: 'weapon',
      rarity: 'legendary',
      rarityLabel: '전설',
      atkBonus: 50000,
      defBonus: 1000,
      critChanceBonus: 100,
      critDamageBonus: 100,
      dodgeBonus: 100,
      enhanceLevel: 10,
      temperCount: 5,
      blessing: { key: 'lifesteal', label: '흡혈 15%', value: 15 }
    };
  } else if (kind === '갑옷') {
    item = {
      name: '🔥 절대갑옷',
      type: 'armor',
      rarity: 'legendary',
      rarityLabel: '전설',
      atkBonus: 10000,
      defBonus: 10000,
      critChanceBonus: 100,
      critDamageBonus: 100,
      dodgeBonus: 100,
      enhanceLevel: 10,
      temperCount: 5,
      blessing: { key: 'reflect', label: '데미지반사 50000%', value: 50000 }
    };
  } else if (kind === '링') {
    item = {
      name: '🔥 절대반지',
      type: 'ring',
      rarity: 'legendary',
      rarityLabel: '전설',
      atkBonus: 23,
      defBonus: 100,
      critChanceBonus: 35,
      critDamageBonus: 500,
      dodgeBonus: 30,
      enhanceLevel: 10,
      temperCount: 5
    };
  } else {
    await message.reply('종류: 검 / 갑옷 / 링 / 세트 / 부활권 / 룬소환석');
    return;
  }

  player.inventory.push(item);
  await safeSave(player);

  await message.reply(
    `✅ ${target.username}에게 ${formatItemName(item)} 지급 완료`
  );
}

if (command === '!골드주기') {
  if (!isAdmin(message)) {
    await message.reply('❌ 관리자만 사용 가능합니다.');
    return;
  }

  const target = message.mentions.users.first();
  if (!target) {
    await message.reply('사용법: !골드주기 @유저 수량');
    return;
  }

  const targetPlayer = getPlayer(target.id);

  const args = message.content.trim().split(/\s+/);
  const amount = Number(args[2]);

  if (isNaN(amount) || amount <= 0) {
    await message.reply('사용법: !골드주기 @유저 수량');
    return;
  }

  targetPlayer.gold = (targetPlayer.gold || 0) + amount;

  await safeSave(player);
  await message.reply(`✅ ${target.username}에게 ${amount}골드를 지급했습니다.`);
  return;
}


  if(command === '!상태'){
    await safeSave(player);
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
🥩 대형물약 500G
🍖🍖 특대물약 1000G
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
    await safeSave(player);
    await message.reply(res.text);
    return;
  }
  if(command === '!장착'){
    const idx = Number(arg) - 1;
    if(Number.isNaN(idx)){ await message.reply('사용법: !장착 1'); return; }
    const text = equipItemByIndex(player, idx);
    await safeSave(player);
    await message.reply(text);
    return;
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
  await safeSave(player);

  if(!dungeonKey){
    await message.reply('이 명령어는 던전 채널에서만 가능합니다.');
    return;
  }

  if(!DUNGEONS[dungeonKey].autoAllowed){
    await message.reply('이 던전은 자동사냥이 불가능합니다.');
    return;
  }

  createRunIfNeeded(player, dungeonKey);
  await safeSave(player);

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
      logs.push(`\n[${i+1}턴]\n👁️ ${player.run.target.name} 등장! `);
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

  await safeSave(player);

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

  const isTown = TOWN_CHANNEL_IDS.has(message.channel.id)


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

  if (id === 'enhance_menu') {
    await interaction.update({
      content: '🔨 강화 메뉴\n원하는 기능을 선택하세요.',
      components: buildEnhanceMenuButtons(player),
    });
    return;
  }

if (id === 'craft_cat_material') {
  await interaction.reply({
    content: `📦 재료 제작목록\n${craftListTextByType(player, 'material')}`,
    components: buildCraftButtonsByType('material'),
    ephemeral: true
  });
  return;
}

  if (id === 'temper_select') {
    await interaction.update({
      content: '⚒️ 담금질할 장비를 선택하세요.\n세계석조각 3개 필요',
      components: buildTemperButtons(player),
    });
    return;
  }

  if (id === 'temper_weapon' || id === 'temper_armor' || id === 'temper_ring') {
    await interaction.deferUpdate();

    let item = null;

    if (id === 'temper_weapon') item = player.equipment.weapon;
    if (id === 'temper_armor') item = player.equipment.armor;
    if (id === 'temper_ring') item = player.equipment.ring;

    const result = tryTemperItem(player, item);

    await safeSave(player);

    await interaction.editReply({
      content: result,
      components: buildTemperButtons(player),
    });
    return;
  }

  if (id.startsWith('sell_')) {
    const index = Number(id.replace('sell_', ''));
    const item = player.inventory[index];

    if (!item) {
      await interaction.reply({ content: '❌ 아이템 없음', ephemeral: true });
      return;
    }

    player.inventory.splice(index, 1);
    player.gold += getItemSellPrice(item);

    await safeSave(player);

    await interaction.reply({
      content: `💰 판매 완료`,
      ephemeral: true
    });
    return;
  }

if (id === 'bless_select') {
  await interaction.update({
    content: '✨ 축성할 장비를 선택하세요.\n축성석 1개 필요 / 장비당 1회만 가능',
    components: buildBlessButtons(player),
  });
  return;
}

if (id === 'bless_weapon' || id === 'bless_armor' || id === 'bless_ring') {
  let item = null;
  if (id === 'bless_weapon') item = player.equipment.weapon;
  if (id === 'bless_armor') item = player.equipment.armor;
  if (id === 'bless_ring') item = player.equipment.ring;

  const result = tryBlessItem(player, item);
  await safeSave(player);

  await interaction.update({
    content: result,
    components: buildBlessButtons(player),
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
// 🎲 룬 뽑기
if (id === 'rune_draw') {
  if ((player.materials['룬소환석'] || 0) < 1) {
    await interaction.reply({
      content: '❌ 룬소환석이 부족합니다.',
      ephemeral: true
    });
    return;
  }

  player.materials['룬소환석'] -= 1;

  const rune = drawRune();
  if (!player.runes) player.runes = [];
  player.runes.push(rune);

  await safeSave(player);

  await interaction.reply({
    content:
`🎲 룬소환석 1개 사용!

획득: ${rune.name}
효과: ${formatRuneStats(rune.stats)}

⚠️ 룬은 장착 후 해제 시 사라집니다.`,
    ephemeral: true
  });
  return;
}


// 🪄 룬 관리 (장착 + 해제 진입)
if (id === 'rune_equip_menu') {
  if (!player.runes) player.runes = [];
  if (!player.equippedRunes) player.equippedRunes = [null, null, null, null];

  const rows = [];

  const groupedRunes = getGroupedRunes(player);

  // 👉 버튼 (종류별 1개)
  if (groupedRunes.length > 0) {
    let row = new ActionRowBuilder();

    groupedRunes.slice(0, 5).forEach((runeGroup) => {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`rune_pick_key_${runeGroup.key}`)
          .setLabel(`${runeGroup.name} x${runeGroup.count}`)
          .setStyle(ButtonStyle.Secondary)
      );
    });

    rows.push(row);
  }

  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('rune_remove_menu')
        .setLabel('🗑 룬해제')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId('rune_cancel')
        .setLabel('❌ 닫기')
        .setStyle(ButtonStyle.Secondary)
    )
  );

  const runeBagText = groupedRunes.length
    ? groupedRunes.map(r => `${r.name} x${r.count} (${formatRuneStats(r.stats)})`).join('\n')
    : '보유한 룬이 없습니다.';

  await interaction.reply({
    content:
`🪄 룬 관리

[현재 장착 슬롯]
${getEquippedRuneStatusText(player)}

[보유 룬]
${runeBagText}

${player.runes.length ? '장착할 룬을 선택하세요.' : '보유한 룬이 없습니다.'}`,
    components: rows,
    ephemeral: true
  });

  return;
}


// 🎯 룬 선택
if (id.startsWith('rune_pick_key_')) {
  if (!player.runes) player.runes = [];
  if (!player.equippedRunes) player.equippedRunes = [null, null, null, null];

  const runeKey = id.replace('rune_pick_key_', '');
  const index = player.runes.findIndex(r => r && r.key === runeKey);
  const rune = index >= 0 ? player.runes[index] : null;

  if (!rune) {
    await interaction.reply({
      content: '❌ 해당 룬을 찾을 수 없습니다.',
      ephemeral: true
    });
    return;
  }

  if (isRuneAlreadyEquipped(player, rune.key)) {
    await interaction.reply({
      content: `❌ ${rune.name}은(는) 이미 장착 중입니다.`,
      ephemeral: true
    });
    return;
  }

  const emptySlot = player.equippedRunes.findIndex(v => v === null);

  if (emptySlot === -1) {
    await interaction.reply({
      content: '❌ 룬 슬롯이 가득 찼습니다.',
      ephemeral: true
    });
    return;
  }

  await interaction.reply({
    content:
`${emptySlot + 1}번 슬롯에 ${rune.name}을 장착합니다.
효과: ${formatRuneStats(rune.stats)}

⚠️ 해제 시 룬은 사라집니다.
정말 장착하시겠습니까?`,
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`rune_confirm_key_${rune.key}`)
          .setLabel('✅ 장착')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId('rune_cancel')
          .setLabel('❌ 취소')
          .setStyle(ButtonStyle.Danger)
      )
    ],
    ephemeral: true
  });

  return;
}


// ✅ 장착 확정
if (id.startsWith('rune_confirm_key_')) {
  if (!player.runes) player.runes = [];
  if (!player.equippedRunes) player.equippedRunes = [null, null, null, null];

  const runeKey = id.replace('rune_confirm_key_', '');
  const index = player.runes.findIndex(r => r && r.key === runeKey);
  const rune = index >= 0 ? player.runes[index] : null;

  if (!rune) {
    await interaction.update({
      content: '❌ 장착할 룬을 찾을 수 없습니다.',
      components: []
    });
    return;
  }

  if (isRuneAlreadyEquipped(player, rune.key)) {
    await interaction.update({
      content: `❌ ${rune.name}은(는) 이미 장착 중입니다.`,
      components: []
    });
    return;
  }

  const slot = player.equippedRunes.findIndex(v => v === null);

  if (slot === -1) {
    await interaction.update({
      content: '❌ 룬 슬롯이 가득 찼습니다.',
      components: []
    });
    return;
  }

  player.equippedRunes[slot] = rune;
  player.runes.splice(index, 1);

  await safeSave(player);

  await interaction.update({
    content:
`✅ ${slot + 1}번 슬롯에 ${rune.name} 장착 완료!

[현재 슬롯]
${getEquippedRuneStatusText(player)}`,
    components: []
  });

  return;
}


// 🗑 해제 메뉴
if (id === 'rune_remove_menu') {
  await interaction.reply({
    content:
`🗑 해제할 슬롯 선택

${getEquippedRuneStatusText(player)}

⚠️ 해제 시 룬은 사라집니다.`,
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('rune_remove_1').setLabel('1번').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('rune_remove_2').setLabel('2번').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('rune_remove_3').setLabel('3번').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('rune_remove_4').setLabel('4번').setStyle(ButtonStyle.Danger)
      )
    ],
    ephemeral: true
  });
  return;
}


// 🗑 해제 선택
if (id.startsWith('rune_remove_') && !id.startsWith('rune_remove_confirm_')) {
  const slot = Number(id.split('_')[2]) - 1;
  const rune = player.equippedRunes[slot];

  if (!rune) {
    await interaction.reply({
      content: '❌ 비어 있음',
      ephemeral: true
    });
    return;
  }

  await interaction.reply({
    content:
`${slot + 1}번 슬롯 ${rune.name} 제거

⚠️ 삭제됩니다.`,
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`rune_remove_confirm_${slot}`).setLabel('✅ 삭제').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('rune_cancel').setLabel('❌ 취소').setStyle(ButtonStyle.Secondary)
      )
    ],
    ephemeral: true
  });

  return;
}


// 🗑 해제 확정
if (id.startsWith('rune_remove_confirm_')) {
  const slot = Number(id.split('_')[3]);
  const rune = player.equippedRunes[slot];

  if (!rune) {
    await interaction.update({
      content: '❌ 없음',
      components: []
    });
    return;
  }

  player.equippedRunes[slot] = null;

  await safeSave(player);

  await interaction.update({
    content:
`🗑 ${rune.name} 삭제됨

${getEquippedRuneStatusText(player)}`,
    components: []
  });

  return;
}


// ❌ 취소
if (id === 'rune_cancel') {
  await interaction.update({
    content: '❌ 취소됨',
    components: []
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
if (id === 'rune_cancel') {
  await interaction.update({
    content: '❌ 취소되었습니다.',
    components: []
  });
  return;
}

  await interaction.deferReply({ ephemeral: true });

  if (startKey === 'town') {
    await interaction.editReply({
      content: '🏘️ 마을입니다! 원하는 기능을 선택하세요.',
      components: buildTownButtons(player)
    });
    return;
  }

  createRunIfNeeded(player, startKey);
  player.run.lastDrops = [];
  await safeSave(player);

  const introTarget = player.run?.target || player.run?.nextTarget;

  await interaction.editReply(
    buildIntroPayload(startKey, introTarget)
  );

  await sleep(INTRO_DELAY_MS);

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
  await safeSave(player);
  await interaction.reply({
    content: buildFullStatusText(player),
    components: buildStatusButtons(player),
    ephemeral: true
  });

  return;
}

  if (id === 'bag_view') {
    await interaction.reply({
      content: buildBagText(player),
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
🍖 x10 큰물약 1000G
🥩 대형물약 500G
🥩 x10 대형물약 5000G
🍖🍖 특대물약 1000G
🍖🍖 x10 특대물약 10000G
🧪 엘릭서 3000G
🧩 고급장비조각 5000G
🧩 x10 고급장비조각 50000G
🌠 룬소환석 300000G`,
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

if (id === 'buy_large_10') {
  const cost = 5000;

  if (player.gold < cost) {
    await interaction.reply({
      content: '❌ 골드가 부족합니다. (대형물약 10개 5000G)',
      ephemeral: true
    });
    return;
  }

  player.gold -= cost;
  player.potions.large = (player.potions.large || 0) + 10;

  await safeSave(player);

  await interaction.reply({
    content:
`✅ 대형물약 10개 구매 완료!

💰 남은 골드: ${player.gold}
🧪 보유 물약:
💊 ${player.potions.small || 0} / 🍗 ${player.potions.mid || 0} / 🍖 ${player.potions.big || 0} / 🥩 ${player.potions.large || 0} / 🍖🍖 ${player.potions.huge || 0} / 🧪 ${player.potions.elixir || 0}`,
    ephemeral: true
  });
  return;
}

if (id === 'buy_huge_10') {
  const cost = 10000;

  if (player.gold < cost) {
    await interaction.reply({
      content: '❌ 골드가 부족합니다. (특대물약 10개 10000G)',
      ephemeral: true
    });
    return;
  }

  player.gold -= cost;
  player.potions.huge = (player.potions.huge || 0) + 10;

  await safeSave(player);

  await interaction.reply({
    content:
`✅ 특대물약 10개 구매 완료!

💰 남은 골드: ${player.gold}
🧪 보유 물약:
💊 ${player.potions.small || 0} / 🍗 ${player.potions.mid || 0} / 🍖 ${player.potions.big || 0} / 🥩 ${player.potions.large || 0} / 🍖🍖 ${player.potions.huge || 0} / 🧪 ${player.potions.elixir || 0}`,
    ephemeral: true
  });
  return;
}

if (id === 'buy_advanced_part_10') {
  const cost = 50000;

  if (player.gold < cost) {
    await interaction.reply({
      content: '❌ 골드가 부족합니다. (고급장비조각 10개 50000G)',
      ephemeral: true
    });
    return;
  }

  player.gold -= cost;
  if (!player.materials) player.materials = {};
  player.materials['고급장비조각'] = (player.materials['고급장비조각'] || 0) + 10;

  await safeSave(player);

  await interaction.reply({
    content:
`✅ 고급장비조각 10개 구매 완료!

💰 남은 골드: ${player.gold}
🧩 보유 재료:
고급장비조각 ${player.materials['고급장비조각'] || 0}개`,
    ephemeral: true
  });
  return;
}

if (id === 'buy_rune_stone') {
  const cost = 300000;

  if (player.gold < cost) {
    await interaction.reply({
      content: '❌ 골드가 부족합니다. (룬소환석 1개 300000G)',
      ephemeral: true
    });
    return;
  }

  player.gold -= cost;
  if (!player.materials) player.materials = {};
  player.materials['룬소환석'] = (player.materials['룬소환석'] || 0) + 1;

  await safeSave(player);

  await interaction.reply({
    content:
`✅ 룬소환석 1개 구매 완료!

💰 남은 골드: ${player.gold}
🌠 보유 재료:
룬소환석 ${player.materials['룬소환석'] || 0}개`,
    ephemeral: true
  });
  return;
}


if (
  id === 'buy_small' ||
  id === 'buy_mid' ||
  id === 'buy_big' ||
  id === 'buy_large' ||
  id === 'buy_huge' ||
  id === 'buy_elixir' ||
  id === 'buy_advanced_part'
) {
const shopMap = {
  buy_small: { key: 'small', name: '작은물약', price: 10, type: 'potion' },
  buy_mid: { key: 'mid', name: '중간물약', price: 30, type: 'potion' },
  buy_big: { key: 'big', name: '큰물약', price: 100, type: 'potion' },
  buy_large: { key: 'large', name: '대형물약', price: 500, type: 'potion' },
  buy_huge: { key: 'huge', name: '특대물약', price: 1000, type: 'potion' },
  buy_elixir: { key: 'elixir', name: '엘릭서', price: 3000, type: 'potion' },

  buy_advanced_part: { key: '고급장비조각', name: '고급장비조각', price: 5000, type: 'material' },
  buy_rune_stone: { key: '룬소환석', name: '룬소환석', price: 300000, type: 'material' },
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

if (buy.type === 'material') {
  await safeSave(player);

  await interaction.reply({
    content:
`✅ ${buy.name} 1개 구매 완료!

💰 남은 골드: ${player.gold}
🧩 보유 재료:
${buy.name} ${player.materials[buy.key] || 0}개`,
    ephemeral: true
  });
  return;
}


if (buy.type === 'potion') {
  player.potions[buy.key] = (player.potions[buy.key] || 0) + 1;
} else if (buy.type === 'material') {
  if (!player.materials) player.materials = {};
  player.materials[buy.key] = (player.materials[buy.key] || 0) + 1;
}

  await safeSave(player);

await interaction.reply({
  content:
`✅ ${buy.name} 1개 구매 완료!

💰 남은 골드: ${player.gold}
🧪 보유 물약:
💊 ${player.potions.small || 0} / 🍗 ${player.potions.mid || 0} / 🍖 ${player.potions.big || 0} / 🥩 ${player.potions.large || 0} / 🍖🍖 ${player.potions.huge || 0} / 🧪 ${player.potions.elixir || 0}`,
  ephemeral: true
});
  return;
}

if (id === 'enhance_view') {
  await interaction.deferReply({ ephemeral: true });

  player.selectedEnhanceTarget = null;

  await interaction.editReply({
    content: `🔨 강화할 아이템을 선택하세요.\n\n${inventoryText(player)}\n\n강화는 골드만 소모됩니다.`,
    components: buildEnhanceItemButtons(player)
  });
  return;
}

if (id.startsWith('enhance_item_')) {
  await interaction.deferReply({ ephemeral: true });

  const idx = Number(id.replace('enhance_item_', ''));
  const item = player.inventory[idx];

  if (!item) {
    await interaction.editReply({
      content: '선택한 아이템이 없습니다.'
    });
    return;
  }

  const text = tryEnhanceItem(player, item);
  await safeSave(player);

  await interaction.editReply({
    content: `${text}\n\n${getEnhancePreviewText(player, item)}`
  });
  return;
}

if (id === 'enhance_equipped_weapon') {
  await interaction.deferReply({ ephemeral: true });

  const item = player.equipment.weapon;

  if (!item) {
    await interaction.editReply({
      content: '착용 무기가 없습니다.'
    });
    return;
  }

  const text = tryEnhanceItem(player, item);
  await safeSave(player);

  await interaction.editReply({
    content: `${text}\n\n${getEnhancePreviewText(player, item)}`
  });
  return;
}

if (id === 'enhance_equipped_armor') {
  await interaction.deferReply({ ephemeral: true });

  const item = player.equipment.armor;

  if (!item) {
    await interaction.editReply({
      content: '착용 갑옷이 없습니다.'
    });
    return;
  }

  const text = tryEnhanceItem(player, item);
  await safeSave(player);

  await interaction.editReply({
    content: `${text}\n\n${getEnhancePreviewText(player, item)}`
  });
  return;
}

if (id === 'enhance_select') {
  const rows = buildEnhanceItemButtons(player);

  if (!rows.length) {
    await interaction.reply({
      content: '강화할 아이템이 없습니다.',
      ephemeral: true
    });
    return;
  }

  await interaction.reply({
    content: '🔨 강화할 아이템을 선택하세요.',
    components: rows,
    ephemeral: true
  });
  return;
}


if (id === 'enhance_equipped_ring') {
  await interaction.deferReply({ ephemeral: true });

  const item = player.equipment.ring;

  if (!item) {
    await interaction.editReply({
      content: '착용 반지가 없습니다.'
    });
    return;
  }

  const text = tryEnhanceItem(player, item);
  await safeSave(player);

  await interaction.editReply({
    content: `${text}\n\n${getEnhancePreviewText(player, item)}`
  });
  return;
}




if (id.startsWith('craft_') && id !== 'craft_list' && !id.startsWith('craft_cat_')) {
  const craftId = id.replace('craft_', '');
  const res = tryCraft(player, craftId);
  await safeSave(player);
  await interaction.reply({
    content: res.text,
    ephemeral: true
  });
  return;
}

if (id.startsWith('equip_')) {
  const idx = Number(id.replace('equip_', ''));
  const text = equipItemByIndex(player, idx);
  await safeSave(player);
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
  player.hp = Math.max(1, Math.floor(getMaxHpWithBless(player)));
  player.run.isDown = false;
  player.respawnAt = 0;

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


  await safeSave(player);




if (id.startsWith('use_')) {
  const key = id.replace('use_', '');

  if (player.run?.target && dungeonKey) {
    const result = usePotionInBattle(player, key);
    await safeSave(player);

    await interaction.update(
      buildBattlePayload(player, interaction.channelId, dungeonKey, result.logs.join('\n'))
    );
    return;
  }

  const text = usePotionOutOfBattle(player, key);
  await safeSave(player);

  await interaction.reply({
    content: text,
    ephemeral: true
  });
  await safeDeleteReply(interaction, 3000);
  return;
}

if (id === 'auto') {
  await interaction.deferUpdate();

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
  await safeSave(player);

  const introTarget = player.run?.target || player.run?.nextTarget;

  // =========================
  // 1) 이미지 먼저 출력
  // =========================
await interaction.editReply(
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

      logs.push(`\n[${i + 1}턴]\n👁️ ${player.run.target.name} 등장! `);
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

  await safeSave(player);

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

if (id === 'attack_1' || id === 'attack_3' || id === 'attack_5') {
  await interaction.deferUpdate();

  const attackCount =
    id === 'attack_5' ? 5 :
    id === 'attack_3' ? 3 :
    1;

  if (!player.run) createRunIfNeeded(player, dungeonKey);

  if (!player.run.target && player.run.nextTarget) {
    player.run.lastDrops = [];
    player.run.target = player.run.nextTarget;
    player.run.nextTarget = null;
    await safeSave(player);

    await interaction.editReply(
      buildIntroPayload(dungeonKey, player.run.target)
    );

    await sleep(INTRO_DELAY_MS);

    await interaction.editReply(
      buildBattlePayload(player, interaction.channelId, dungeonKey, '전투 시작!')
    );
    return;
  }

  const logs = [];

  for (let i = 0; i < attackCount; i++) {
    if (!player.run) break;
    if (player.run.isDown) break;
    if (!player.run.target) break;

    logs.push(`\n⚔️ [${i + 1}타]`);

    const result = performAttack(player, dungeonKey);
    logs.push(...result.logs);

    // 죽었으면 중단
    if (Date.now() < player.respawnAt) break;

    // 몬스터 죽어서 다음 몬스터 대기 상태면 중단
    if (!player.run?.target && player.run?.nextTarget) break;

    // 전투 종료됐으면 중단
    if (!player.run) break;
  }

  await safeSave(player);

  await interaction.editReply(
    buildBattlePayload(player, interaction.channelId, dungeonKey, logs.join('\n'))
  );
  return;
}


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



 