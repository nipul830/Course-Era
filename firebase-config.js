// Course Era Firebase client configuration
const firebaseConfig = {
  apiKey: "AIzaSyBqrMvKivVsrVEr8hwDpVWg8f3ZfZttLVQ",
  authDomain: "courseera-22425.firebaseapp.com",
  projectId: "courseera-22425",
  storageBucket: "courseera-22425.firebasestorage.app",
  messagingSenderId: "263442433438",
  appId: "1:263442433438:web:31a490f6ee3579322f828f",
  measurementId: "G-3T6QSQNN2M"
};

if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
const ceAuth = firebase.auth();
ceAuth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);
