# Directrices de Eficiencia y Enrutamiento

## 1. Higiene de Contexto (Cero Lecturas Ciegas)
- PROHIBIDO leer archivos completos de más de 250 líneas de forma directa.
- Usa `grep`, `ripgrep` o búsqueda por símbolos primero para localizar el número de línea exacto.
- Lee únicamente rangos de líneas específicos (+/- 30 líneas alrededor del objetivo).
- Ignora siempre directorios y archivos pesados (`node_modules`, `dist`, `build`, `.next`, `.firebase`, `package-lock.json`, logs).

## 2. División Operativa por Modelo
- **Modo Flash (3.8 Flash):** Úsalo para mapeo del repositorio, búsqueda de referencias, generación de tipados/interfaces TypeScript, tests unitarios, ajustes rápidos de UI/CSS y lectura de logs.
- **Modo Pesado (Sonnet / Argon):** Actívalo solo cuando el problema requiera refactorización multi-archivo, lógica de concurrencia, seguridad, pasarelas de pago, bots o resolución de bugs de estado complejos.

## 3. Formato de Respuesta
- Cero introducciones, saludos o resúmenes al final. Ve directo al código o al diagnóstico.
- Si necesitas explicar un plan antes de editar, hazlo en máximo 3 viñetas de una sola línea.
