/* 口譯 — built-in phrasebook (works offline). zh = 中文, ja = 日本語, en = English. */
window.PHRASES = [
  {
    id: 'open', name: '開場', items: [
      { zh: '不好意思，我在用翻譯 App，可以請你對著手機慢慢說嗎？', ja: 'すみません、翻訳アプリを使っています。このスマホに向かって、ゆっくり話していただけますか。', en: "Excuse me, I'm using a translation app. Could you please speak slowly toward this phone?" },
      { zh: '不好意思（叫人）', ja: 'すみません。', en: 'Excuse me.' },
      { zh: '謝謝', ja: 'ありがとうございます。', en: 'Thank you very much.' },
      { zh: '我不會說日文', ja: '日本語が話せません。', en: "I don't speak Japanese." },
      { zh: '請再說一次', ja: 'もう一度言っていただけますか？', en: 'Could you say that again, please?' },
      { zh: '請說慢一點', ja: 'もう少しゆっくり話していただけますか？', en: 'Could you speak a little more slowly?' },
      { zh: '可以寫在這裡嗎？', ja: 'ここに書いていただけますか？', en: 'Could you write it down here?' },
    ],
  },
  {
    id: 'food', name: '餐廳', items: [
      { zh: '我們 4 位', ja: '4人です。', en: 'There are four of us.' },
      { zh: '沒有預約', ja: '予約はしていません。', en: "We don't have a reservation." },
      { zh: '有預約', ja: '予約しています。', en: 'We have a reservation.' },
      { zh: '有中文或英文菜單嗎？', ja: '中国語か英語のメニューはありますか？', en: 'Do you have a menu in Chinese or English?' },
      { zh: '推薦什麼？', ja: 'おすすめは何ですか？', en: 'What do you recommend?' },
      { zh: '我要這個', ja: 'これをお願いします。', en: "I'd like this one, please." },
      { zh: '我有食物過敏', ja: '食物アレルギーがあります。', en: 'I have a food allergy.' },
      { zh: '要等多久？', ja: 'どのくらい待ちますか？', en: 'How long is the wait?' },
      { zh: '可以外帶嗎？', ja: '持ち帰りできますか？', en: 'Can I get this to go?' },
      { zh: '麻煩結帳', ja: 'お会計をお願いします。', en: 'Could I have the check, please?' },
      { zh: '可以分開付嗎？', ja: '別々に払えますか？', en: 'Can we pay separately?' },
      { zh: '可以刷卡嗎？', ja: 'カードは使えますか？', en: 'Can I pay by card?' },
    ],
  },
  {
    id: 'shop', name: '購物', items: [
      { zh: '可以辦免稅嗎？', ja: '免税の手続きはできますか？', en: 'Can I get this tax-free?' },
      { zh: '這是我的護照', ja: 'パスポートはこちらです。', en: 'Here is my passport.' },
      { zh: '這個多少錢？', ja: 'これはいくらですか？', en: 'How much is this?' },
      { zh: '有其他尺寸或顏色嗎？', ja: '他のサイズや色はありますか？', en: 'Do you have other sizes or colors?' },
      { zh: '可以試穿嗎？', ja: '試着してもいいですか？', en: 'May I try this on?' },
      { zh: '請給我袋子', ja: '袋をお願いします。', en: 'Could I have a bag, please?' },
    ],
  },
  {
    id: 'car', name: '開車', items: [
      { zh: '一般汽油加滿', ja: 'レギュラー満タンでお願いします。', en: 'Fill it up with regular, please.' },
      { zh: '我要刷卡', ja: 'カードで払います。', en: "I'll pay by card." },
      { zh: '我付現金', ja: '現金で払います。', en: "I'll pay in cash." },
      { zh: '附近有加油站嗎？', ja: '近くにガソリンスタンドはありますか？', en: 'Is there a gas station nearby?' },
      { zh: '這裡可以停車嗎？', ja: 'ここに車を停めてもいいですか？', en: 'Can I park here?' },
      { zh: '停車場在哪裡？', ja: '駐車場はどこですか？', en: 'Where is the parking lot?' },
      { zh: '我來還車', ja: '車を返しに来ました。', en: "I'm here to return the car." },
      { zh: '發生車禍了', ja: '交通事故にあいました。', en: "I've been in a car accident." },
    ],
  },
  {
    id: 'go', name: '交通', items: [
      { zh: '廁所在哪裡？', ja: 'トイレはどこですか？', en: 'Where is the restroom?' },
      { zh: '車站在哪裡？', ja: '駅はどこですか？', en: 'Where is the station?' },
      { zh: '可以幫我叫計程車嗎？', ja: 'タクシーを呼んでいただけますか？', en: 'Could you call a taxi for me?' },
      { zh: '走路要多久？', ja: '歩いてどのくらいかかりますか？', en: 'How long does it take on foot?' },
      { zh: '請在這裡停（計程車）', ja: 'ここで止めてください。', en: 'Please stop here.' },
    ],
  },
  {
    id: 'stay', name: '住宿', items: [
      { zh: '我要辦入住', ja: 'チェックインをお願いします。', en: "I'd like to check in, please." },
      { zh: '可以寄放行李嗎？', ja: '荷物を預かっていただけますか？', en: 'Could you keep our luggage?' },
      { zh: '早餐幾點開始？', ja: '朝食は何時からですか？', en: 'What time does breakfast start?' },
      { zh: '有毛巾嗎？', ja: 'タオルはありますか？', en: 'Do you have towels?' },
      { zh: 'Wi-Fi 密碼是什麼？', ja: 'Wi-Fiのパスワードを教えてください。', en: "What's the Wi-Fi password?" },
    ],
  },
  {
    id: 'sos', name: '緊急', items: [
      { zh: '請叫救護車', ja: '救急車を呼んでください。', en: 'Please call an ambulance.' },
      { zh: '附近有醫院嗎？', ja: '近くに病院はありますか？', en: 'Is there a hospital nearby?' },
      { zh: '藥局在哪裡？', ja: '薬局はどこですか？', en: 'Where is the pharmacy?' },
      { zh: '我身體不舒服', ja: '気分が悪いです。', en: "I don't feel well." },
      { zh: '我的錢包不見了', ja: '財布をなくしました。', en: "I've lost my wallet." },
      { zh: '請幫我報警', ja: '警察を呼んでください。', en: 'Please call the police.' },
    ],
  },
];
