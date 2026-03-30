/* =========================
2) 전투 버튼 함수 교체
기존 buildBattleButtons 함수를 이걸로 통째로 교체
- 가방 버튼 추가
- 물약 버튼 이모지 전부 🧪 로 통일
========================= */

function buildBattleButtons(player, dungeonKey){
  const canAuto = DUNGEONS[dungeonKey]?.autoAllowed || false;
  const down = player.run?.isDown;

  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('attack').setLabel('⚔️ 공격').setStyle(ButtonStyle.Danger).setDisabled(down),
      new ButtonBuilder().setCustomId('use_small').setLabel('🧪').setStyle(ButtonStyle.Secondary).setDisabled(down),
      new ButtonBuilder().setCustomId('use_mid').setLabel('🧪').setStyle(ButtonStyle.Secondary).setDisabled(down),
      new ButtonBuilder().setCustomId('status').setLabel('📋 상태창').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('bag_view').setLabel('🎒 가방').setStyle(ButtonStyle.Primary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('shop').setLabel('🏪 상점').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('use_big').setLabel('🧪').setStyle(ButtonStyle.Secondary).setDisabled(down),
      new ButtonBuilder().setCustomId('use_elixir').setLabel('🧪').setStyle(ButtonStyle.Secondary).setDisabled(down),
      new ButtonBuilder().setCustomId('auto').setLabel(canAuto ? '🤖 자동' : '자동불가').setStyle(canAuto ? ButtonStyle.Success : ButtonStyle.Secondary).setDisabled(!canAuto || down),
      new ButtonBuilder().setCustomId('revive').setLabel('🪽 부활권').setStyle(ButtonStyle.Success).setDisabled(!down || player.reviveTickets<=0),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('craft_list').setLabel('🛠️ 제작').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('equipment_view').setLabel('🧰 장비').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('enhance_view').setLabel('🔨 강화').setStyle(ButtonStyle.Primary),
    ),
  ];
}
