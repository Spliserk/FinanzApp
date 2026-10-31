// ============================================================================
//  CONFIGURACIÓN DE FIREBASE
// ----------------------------------------------------------------------------
//  Pega aquí la config de tu proyecto de Firebase.
//
//  ¿De dónde la saco?
//    1. Entra a https://console.firebase.google.com
//    2. Crea un proyecto (o usa el mismo del inventario del lab).
//    3. En el proyecto: ícono de engranaje ⚙️ → "Configuración del proyecto".
//    4. Baja a "Tus apps" → ícono web </> → registra una app web.
//    5. Copia el objeto `firebaseConfig` que te muestra y reemplázalo abajo.
//
//  Estas claves NO son secretas: van en el navegador a propósito. La seguridad
//  de verdad la ponen las Reglas de Firestore (ver firestore.rules).
// ============================================================================

export const firebaseConfig = {
  apiKey: 'PEGA_AQUI_TU_API_KEY',
  authDomain: 'PEGA_AQUI.firebaseapp.com',
  projectId: 'PEGA_AQUI_TU_PROJECT_ID',
  storageBucket: 'PEGA_AQUI.appspot.com',
  messagingSenderId: 'PEGA_AQUI',
  appId: 'PEGA_AQUI',
};
