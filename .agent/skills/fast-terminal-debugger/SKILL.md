---
name: fast-terminal-debugger
description: Depuración eficiente de errores de consola, compilación, Node.js, PM2 y ejecución sin contaminar la ventana de contexto.
---

# Reglas de Depuración en Terminal

1. **Filtrado Estricto de Salida:**
   - Nunca vuelques cientos de líneas de consola al contexto.
   - Al ejecutar tests, builds o revisar logs en terminal, filtra siempre la salida usando `tail -n 30` o `grep -i -C 3 "error"`.

2. **Ciclo Corto de Corrección:**
   - Sigue estrictamente este orden: Lee el stack trace -> Ubica archivo y línea exacta -> Lee solo esa función (+/- 25 líneas) -> Aplica el fix -> Verifica compilación o ejecución.
   - Prohibido dar explicaciones teóricas sobre por qué ocurre el error a menos que el usuario pregunte explícitamente "¿por qué pasó esto?".
