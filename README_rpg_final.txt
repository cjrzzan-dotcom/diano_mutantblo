분할 완성본 안내

파일:
- rpg_final_part1.js
- rpg_final_part2.js
- rpg_final_part3.js

사용 방법:
1. 위 3개 파일 내용을 순서대로 합쳐서 rpg_bot_final.js 로 저장
2. 같은 폴더에 data_rpg_final.json 두기
3. images 폴더 만들기
4. 몬스터 이름과 같은 파일명으로 이미지 넣기
   예) images/안다리엘.png, images/디아블로.jpg
5. .env 파일 생성 후 토큰 입력
6. npm install discord.js dotenv
7. node rpg_bot_final.js

이번 버전에 포함된 것:
- 채널별 던전
- 초심자의 숲 / 오색룡의 둥지 = 랜덤
- 나머지 = 웨이브
- 이미지 파일 첨부 방식
- 시작 시 이미지 표시 후 1초 뒤 전투 시작
- 자동사냥은 초반 2던전만
- 속성 / 속성석 / 2속성 강화
- 부활권 랜덤 드랍
- 사망 시 30분 대기
- 레벨업 / 스탯포인트
- 상태창에서 스탯 버튼
- 공격 / 크리 / 크뎀 / 회피 스탯
- 최대치 도달 시 포인트 차감 없이 막힘
- 물약 사용도 한 턴 소모
- 마을 채널 레벨업 / 유니크 이상 아이템 알림
