# TM30 Backend (Mongo + Sessions) - v2 (MRZ efficient)

Backend Node.js + Express + MongoDB para:
- Login con sesiones (cookie)
- CRUD de usuarios (solo admin)
- Upload de imagen:
  - `passportImageMrz` (recorte MRZ recomendado desde frontend)
  - `passportImageFull` (opcional: foto completa)
- OCR robusto: crop + multipass (threshold/rotación/sharpen) y elección por check-digits
- Guardado de guest + stay
- Export Excel TM30 del día (xlsx)

## Setup
```bash
cp .env.example .env
npm i
npm run dev
```

## Login
POST /api/auth/login { email, password }

En frontend: `credentials: "include"` (fetch) / `withCredentials: true` (axios)

## Crear stay (multipart/form-data)
POST /api/stays
- checkOutDate (DD/MM/YYYY) [requerido]
- phoneNo (opcional)
- checkInDate (opcional YYYY-MM-DD)
- passportImageMrz (file)  <-- recomendado (recorte MRZ del frontend)
- passportImageFull (file) <-- opcional

El backend usa primero `passportImageMrz`. Si no viene, usa `passportImageFull`.
Si falla MRZ, devuelve 422.

Respuesta incluye:
- warnings (si score < 3)
- mrzScore (0..3)

## Export
GET /api/export/tm30?date=YYYY-MM-DD
