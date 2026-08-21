import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyAtzqgvNFWhybqBLcq6D7p5p_NJss4TIFw",
  authDomain: "sales-check-c0dcb.firebaseapp.com",
  projectId: "sales-check-c0dcb",
  storageBucket: "sales-check-c0dcb.firebasestorage.app",
  messagingSenderId: "935740793870",
  appId: "1:935740793870:web:816cd81af890a24f60085f",
  measurementId: "G-49WM1YN3EW"
};

const app = initializeApp(firebaseConfig);

export const db = getFirestore(app);

