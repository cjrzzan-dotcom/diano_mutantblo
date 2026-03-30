/* =========================
4) 명령어 / 버튼 처리 추가
아래 블록을 기존 messageCreate / interactionCreate 안에 추가
========================= */

/* messageCreate 안에 추가 */
if(command === '!가방'){
  saveData(db);
  await message.reply({ content:buildBagText(player) });
  return;
}

/* interactionCreate 안에 추가 */
if(id === 'bag_view'){
  await interaction.deferReply({ ephemeral:true });
  await interaction.editReply({ content:buildBagText(player) });
  return;
}
