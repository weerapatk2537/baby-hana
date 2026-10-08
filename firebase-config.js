// วางค่าจาก Firebase Console > Project settings > Your apps > Web app (SDK setup and configuration > Config)
// ค่าเหล่านี้เปิดเผยได้ ไม่ใช่รหัสลับ การป้องกันข้อมูลอยู่ที่ firestore.rules
export const firebaseConfig = {
  apiKey: "PASTE_API_KEY",
  authDomain: "PASTE_PROJECT_ID.firebaseapp.com",
  projectId: "PASTE_PROJECT_ID",
  storageBucket: "PASTE_PROJECT_ID.appspot.com",
  messagingSenderId: "PASTE_SENDER_ID",
  appId: "PASTE_APP_ID",
};
