---
name: surgical-code-editor
description: Aplica cambios quirúrgicos en el código evitando reescrituras completas, gasto excesivo de output tokens y sobre-ingeniería.
---

# Reglas de Edición Quirúrgica (Sonnet / Argon / Hydrogen)

1. **Prohibido Reescribir Archivos Completos:**
   - Aplica diffs mínimos enfocados estrictamente en las líneas afectadas.
   - Nunca uses comentarios perezosos como `// ... resto del código ...` dentro de una herramienta de reemplazo que borre código real, pero limita el bloque de reemplazo únicamente a la función o líneas modificadas.
   - Mantén intactos los comentarios, imports y formatos adyacentes que no sean parte del bug o feature.

2. **Principio de Mínima Invasión:**
   - No cambies nombres de variables existentes, no agregues librerías nuevas al `package.json` ni modifiques la estructura de carpetas a menos que se pida explícitamente.
   - Si encuentras código "mejorable" o warnings fuera del alcance del prompt actual, ignóralos por completo.

3. **Validación Pre-Edición:**
   - Antes de modificar la firma de una función compartida o un esquema de datos, verifica con una búsqueda rápida qué otros archivos la importan para no romper contratos ni tipados.
