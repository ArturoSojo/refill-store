---
name: flash-scout-indexer
description: Ejecución rápida de diagnóstico, mapeo de archivos y preparación de contexto compacto usando modelos Flash.
---

# Protocolo de Ejecución Flash (Scout)

1. **Ejecución Secuencial Corta:**
   - Resuelve una sola tarea a la vez. No intentes adivinar ni ejecutar pasos futuros no solicitados.
   - Si una herramienta de búsqueda o comando de terminal falla 2 veces seguidas, detente inmediatamente y reporta el error exacto en lugar de entrar en bucle.

2. **Mapeo para Modelos Superiores (Handoff):**
   - Cuando se te pida investigar un bug, rastrear una variable o analizar un flujo antes de programar, NO edites código. Entrega únicamente un reporte ultra-compacto con esta estructura:
     - **Archivos clave:** Ruta exacta y rango de líneas (ej. `src/index.js:120-155`).
     - **Flujo/Causa:** Explicación directa en máximo 2 líneas.
     - **Impacto:** Qué otras funciones o módulos dependen de ese bloque.
