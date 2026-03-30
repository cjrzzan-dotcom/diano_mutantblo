/* =========================
1) 상태창 / 가방 함수 교체
기존 buildFullStatusText 함수를 이걸로 통째로 교체
그 아래 buildBagText 함수를 새로 추가
========================= */

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
