package io.github.kahme247.ompweb.ui.render

/**
 * Small, dependency-free syntax highlighter for fenced code blocks.
 *
 * It is intentionally a tokenizer, not a parser: strings and comments win over
 * keywords, escapes are honoured, and unknown languages simply produce no
 * spans (plain text). Mirrors the visual role of `lib/syntax-highlight.ts`
 * without pulling highlight.js into the APK.
 */
object SyntaxHighlighter {

    enum class Kind { Keyword, Type, String, Comment, Number, Literal }

    data class Span(val start: Int, val end: Int, val kind: Kind)

    fun highlight(code: String, language: String?): List<Span> {
        val spec = specFor(language) ?: return emptyList()
        if (code.isEmpty()) return emptyList()
        val spans = ArrayList<Span>()
        var i = 0
        val n = code.length
        while (i < n) {
            val c = code[i]

            val lineComment = spec.lineComments.firstOrNull { code.startsWith(it, i) }
            if (lineComment != null) {
                val end = code.indexOf('\n', i).let { if (it < 0) n else it }
                spans.add(Span(i, end, Kind.Comment))
                i = end
                continue
            }

            if (spec.blockComment != null && code.startsWith(spec.blockComment.first, i)) {
                val close = code.indexOf(spec.blockComment.second, i + spec.blockComment.first.length)
                val end = if (close < 0) n else close + spec.blockComment.second.length
                spans.add(Span(i, end, Kind.Comment))
                i = end
                continue
            }

            val quote = when {
                spec.tripleQuotes && (code.startsWith("\"\"\"", i) || code.startsWith("'''", i)) -> code.substring(i, i + 3)
                c in spec.quotes -> c.toString()
                else -> null
            }
            if (quote != null) {
                var j = i + quote.length
                while (j < n) {
                    if (code[j] == '\\' && quote.length == 1) {
                        j += 2
                        continue
                    }
                    if (code.startsWith(quote, j)) {
                        j += quote.length
                        break
                    }
                    if (code[j] == '\n' && quote.length == 1 && quote != "`") {
                        break
                    }
                    j++
                }
                spans.add(Span(i, j.coerceAtMost(n), Kind.String))
                i = j.coerceAtMost(n)
                continue
            }

            if (c.isLetter() || c == '_') {
                var j = i + 1
                while (j < n && (code[j].isLetterOrDigit() || code[j] == '_' || code[j] == '$')) j++
                val word = code.substring(i, j)
                when {
                    spec.literals.contains(word) -> spans.add(Span(i, j, Kind.Literal))
                    spec.types.contains(word) -> spans.add(Span(i, j, Kind.Type))
                    spec.keywords.contains(word) -> spans.add(Span(i, j, Kind.Keyword))
                }
                i = j
                continue
            }

            if (c.isDigit()) {
                var j = i + 1
                while (j < n) {
                    val next = code[j]
                    if (next.isLetterOrDigit() || next == '_' || next == '.') {
                        // Stop `1..5` from becoming one number literal.
                        if (next == '.' && j + 1 < n && code[j + 1] == '.') break
                        j++
                    } else {
                        break
                    }
                }
                spans.add(Span(i, j, Kind.Number))
                i = j
                continue
            }

            i++
        }
        return spans
    }

    private data class LanguageSpec(
        val keywords: Set<String>,
        val types: Set<String>,
        val literals: Set<String>,
        val lineComments: List<String>,
        val blockComment: Pair<String, String>?,
        val quotes: Set<Char>,
        val tripleQuotes: Boolean = false,
    )

    private val COMMON_LITERALS = setOf("true", "false", "null", "nil", "None", "True", "False", "undefined")

    private fun specFor(language: String?): LanguageSpec? {
        val name = language?.trim()?.lowercase()?.removePrefix("language-")?.removePrefix("lang-") ?: return null
        return when (name) {
            "kt", "kotlin", "kts" -> LanguageSpec(
                keywords = KOTLIN_KEYWORDS,
                types = KOTLIN_TYPES,
                literals = COMMON_LITERALS,
                lineComments = listOf("//"),
                blockComment = "/*" to "*/",
                quotes = setOf('"', '\''),
            )
            "java" -> LanguageSpec(
                keywords = JAVA_KEYWORDS,
                types = JAVA_TYPES,
                literals = COMMON_LITERALS,
                lineComments = listOf("//"),
                blockComment = "/*" to "*/",
                quotes = setOf('"', '\''),
            )
            "js", "javascript", "jsx", "mjs", "cjs" -> LanguageSpec(
                keywords = JS_KEYWORDS,
                types = JS_TYPES,
                literals = COMMON_LITERALS,
                lineComments = listOf("//"),
                blockComment = "/*" to "*/",
                quotes = setOf('"', '\'', '`'),
            )
            "ts", "typescript", "tsx" -> LanguageSpec(
                keywords = JS_KEYWORDS + setOf("interface", "type", "enum", "namespace", "declare", "abstract", "implements", "readonly", "is", "keyof", "infer", "satisfies", "as"),
                types = JS_TYPES + setOf("string", "number", "boolean", "any", "unknown", "never", "void", "object"),
                literals = COMMON_LITERALS,
                lineComments = listOf("//"),
                blockComment = "/*" to "*/",
                quotes = setOf('"', '\'', '`'),
            )
            "py", "python", "python3" -> LanguageSpec(
                keywords = PYTHON_KEYWORDS,
                types = PYTHON_TYPES,
                literals = COMMON_LITERALS,
                lineComments = listOf("#"),
                blockComment = null,
                quotes = setOf('"', '\''),
                tripleQuotes = true,
            )
            "go", "golang" -> LanguageSpec(
                keywords = GO_KEYWORDS,
                types = GO_TYPES,
                literals = COMMON_LITERALS,
                lineComments = listOf("//"),
                blockComment = "/*" to "*/",
                quotes = setOf('"', '\'', '`'),
            )
            "rs", "rust" -> LanguageSpec(
                keywords = RUST_KEYWORDS,
                types = RUST_TYPES,
                literals = COMMON_LITERALS,
                lineComments = listOf("//"),
                blockComment = "/*" to "*/",
                quotes = setOf('"'),
            )
            "c", "h", "cpp", "c++", "cc", "cxx", "hpp" -> LanguageSpec(
                keywords = C_KEYWORDS,
                types = C_TYPES,
                literals = COMMON_LITERALS,
                lineComments = listOf("//"),
                blockComment = "/*" to "*/",
                quotes = setOf('"', '\''),
            )
            "cs", "csharp", "c#" -> LanguageSpec(
                keywords = CSHARP_KEYWORDS,
                types = CSHARP_TYPES,
                literals = COMMON_LITERALS,
                lineComments = listOf("//"),
                blockComment = "/*" to "*/",
                quotes = setOf('"', '\''),
            )
            "swift" -> LanguageSpec(
                keywords = SWIFT_KEYWORDS,
                types = SWIFT_TYPES,
                literals = COMMON_LITERALS,
                lineComments = listOf("//"),
                blockComment = "/*" to "*/",
                quotes = setOf('"'),
            )
            "sh", "bash", "shell", "zsh", "console" -> LanguageSpec(
                keywords = SHELL_KEYWORDS,
                types = emptySet(),
                literals = COMMON_LITERALS,
                lineComments = listOf("#"),
                blockComment = null,
                quotes = setOf('"', '\''),
            )
            "json", "jsonc" -> LanguageSpec(
                keywords = emptySet(),
                types = emptySet(),
                literals = setOf("true", "false", "null"),
                lineComments = if (name == "jsonc") listOf("//") else emptyList(),
                blockComment = if (name == "jsonc") "/*" to "*/" else null,
                quotes = setOf('"'),
            )
            "yaml", "yml" -> LanguageSpec(
                keywords = setOf("true", "false", "null", "yes", "no", "on", "off"),
                types = emptySet(),
                literals = emptySet(),
                lineComments = listOf("#"),
                blockComment = null,
                quotes = setOf('"', '\''),
            )
            "toml", "ini", "properties", "dotenv", "env" -> LanguageSpec(
                keywords = emptySet(),
                types = emptySet(),
                literals = setOf("true", "false"),
                lineComments = listOf("#", ";"),
                blockComment = null,
                quotes = setOf('"', '\''),
            )
            "sql" -> LanguageSpec(
                keywords = SQL_KEYWORDS,
                types = SQL_TYPES,
                literals = setOf("NULL", "TRUE", "FALSE"),
                lineComments = listOf("--"),
                blockComment = "/*" to "*/",
                quotes = setOf('\'', '"'),
            )
            "xml", "html", "xhtml", "svg", "vue" -> LanguageSpec(
                keywords = emptySet(),
                types = emptySet(),
                literals = emptySet(),
                lineComments = listOf("<!--"),
                blockComment = null,
                quotes = setOf('"', '\''),
            )
            "css", "scss", "sass", "less" -> LanguageSpec(
                keywords = setOf("@media", "@import", "@keyframes", "@supports", "@font-face"),
                types = emptySet(),
                literals = emptySet(),
                lineComments = listOf(),
                blockComment = "/*" to "*/",
                quotes = setOf('"', '\''),
            )
            "rb", "ruby" -> LanguageSpec(
                keywords = setOf("def", "end", "class", "module", "if", "elsif", "else", "unless", "while", "until", "for", "in", "do", "begin", "rescue", "ensure", "return", "yield", "require", "include", "extend", "attr_accessor", "attr_reader", "attr_writer", "self", "super", "nil", "true", "false", "and", "or", "not", "then", "case", "when", "raise", "lambda", "proc", "puts"),
                types = emptySet(),
                literals = setOf("true", "false", "nil"),
                lineComments = listOf("#"),
                blockComment = null,
                quotes = setOf('"', '\''),
            )
            "php" -> LanguageSpec(
                keywords = setOf("function", "class", "public", "private", "protected", "static", "return", "if", "else", "elseif", "while", "for", "foreach", "switch", "case", "break", "continue", "new", "echo", "namespace", "use", "extends", "implements", "abstract", "final", "const", "try", "catch", "finally", "throw", "as", "instanceof", "global", "isset", "unset", "empty"),
                types = emptySet(),
                literals = setOf("true", "false", "null", "TRUE", "FALSE", "NULL"),
                lineComments = listOf("//", "#"),
                blockComment = "/*" to "*/",
                quotes = setOf('"', '\''),
            )
            "dart" -> LanguageSpec(
                keywords = setOf("class", "abstract", "extends", "implements", "with", "mixin", "enum", "final", "const", "var", "late", "static", "void", "return", "if", "else", "for", "while", "do", "switch", "case", "break", "continue", "try", "catch", "finally", "throw", "new", "async", "await", "yield", "import", "export", "library", "part", "get", "set", "required", "factory", "operator", "super", "this"),
                types = setOf("int", "double", "num", "String", "bool", "List", "Map", "Set", "Future", "Stream", "Object", "dynamic", "void"),
                literals = COMMON_LITERALS,
                lineComments = listOf("//"),
                blockComment = "/*" to "*/",
                quotes = setOf('"', '\''),
            )
            else -> null
        }
    }

    private val KOTLIN_KEYWORDS = setOf(
        "as", "break", "class", "continue", "do", "else", "false", "for", "fun", "if", "in", "interface",
        "is", "null", "object", "package", "return", "super", "this", "throw", "true", "try", "typealias",
        "typeof", "val", "var", "when", "while", "by", "catch", "constructor", "delegate", "dynamic", "field",
        "file", "finally", "get", "import", "init", "param", "property", "receiver", "set", "setparam", "where",
        "actual", "abstract", "annotation", "companion", "const", "crossinline", "data", "enum", "expect",
        "external", "final", "infix", "inline", "inner", "internal", "lateinit", "noinline", "open", "operator",
        "out", "override", "private", "protected", "public", "reified", "sealed", "suspend", "tailrec", "vararg",
    )
    private val KOTLIN_TYPES = setOf(
        "Any", "Array", "Boolean", "Byte", "Char", "Double", "Float", "Int", "Long", "Nothing", "Short",
        "String", "Unit", "List", "MutableList", "Map", "MutableMap", "Set", "MutableSet", "Pair", "Triple",
        "Sequence", "Iterable", "Collection", "Result", "Lazy", "Comparable", "Exception", "Throwable",
    )
    private val JAVA_KEYWORDS = setOf(
        "abstract", "assert", "break", "case", "catch", "class", "const", "continue", "default", "do", "else",
        "enum", "extends", "final", "finally", "for", "if", "implements", "import", "instanceof", "interface",
        "native", "new", "package", "private", "protected", "public", "return", "static", "strictfp", "super",
        "switch", "synchronized", "this", "throw", "throws", "transient", "try", "volatile", "while", "var",
        "record", "sealed", "permits", "yield",
    )
    private val JAVA_TYPES = setOf(
        "boolean", "byte", "char", "double", "float", "int", "long", "short", "void", "String", "Object",
        "Integer", "Long", "Double", "Float", "Boolean", "Character", "List", "Map", "Set", "Optional",
    )
    private val JS_KEYWORDS = setOf(
        "async", "await", "break", "case", "catch", "class", "const", "continue", "debugger", "default",
        "delete", "do", "else", "export", "extends", "finally", "for", "function", "if", "import", "in",
        "instanceof", "let", "new", "of", "return", "static", "super", "switch", "this", "throw", "try",
        "typeof", "var", "void", "while", "with", "yield", "get", "set",
    )
    private val JS_TYPES = setOf(
        "Array", "Boolean", "Date", "Error", "Function", "JSON", "Map", "Math", "Number", "Object", "Promise",
        "Proxy", "RegExp", "Set", "String", "Symbol", "WeakMap", "WeakSet", "BigInt", "console", "window",
        "document", "globalThis",
    )
    private val PYTHON_KEYWORDS = setOf(
        "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del", "elif", "else",
        "except", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal", "not",
        "or", "pass", "raise", "return", "try", "while", "with", "yield", "match", "case",
    )
    private val PYTHON_TYPES = setOf(
        "bool", "bytes", "dict", "float", "frozenset", "int", "list", "object", "set", "str", "tuple", "type",
        "Exception", "ValueError", "TypeError", "KeyError", "self", "cls", "None", "True", "False",
    )
    private val GO_KEYWORDS = setOf(
        "break", "case", "chan", "const", "continue", "default", "defer", "else", "fallthrough", "for", "func",
        "go", "goto", "if", "import", "interface", "map", "package", "range", "return", "select", "struct",
        "switch", "type", "var",
    )
    private val GO_TYPES = setOf(
        "bool", "byte", "complex64", "complex128", "error", "float32", "float64", "int", "int8", "int16",
        "int32", "int64", "rune", "string", "uint", "uint8", "uint16", "uint32", "uint64", "uintptr", "any",
        "true", "false", "nil", "iota",
    )
    private val RUST_KEYWORDS = setOf(
        "as", "async", "await", "break", "const", "continue", "crate", "dyn", "else", "enum", "extern", "false",
        "fn", "for", "if", "impl", "in", "let", "loop", "match", "mod", "move", "mut", "pub", "ref", "return",
        "self", "Self", "static", "struct", "super", "trait", "true", "type", "unsafe", "use", "where", "while",
    )
    private val RUST_TYPES = setOf(
        "bool", "char", "f32", "f64", "i8", "i16", "i32", "i64", "i128", "isize", "str", "String", "u8", "u16",
        "u32", "u64", "u128", "usize", "Vec", "Option", "Result", "Box", "Rc", "Arc", "HashMap", "HashSet",
        "Some", "None", "Ok", "Err",
    )
    private val C_KEYWORDS = setOf(
        "auto", "break", "case", "const", "continue", "default", "do", "else", "enum", "extern", "for", "goto",
        "if", "inline", "register", "restrict", "return", "sizeof", "static", "struct", "switch", "typedef",
        "union", "volatile", "while", "class", "namespace", "template", "typename", "public", "private",
        "protected", "virtual", "override", "new", "delete", "try", "catch", "throw", "using", "constexpr",
        "nullptr", "true", "false", "this",
    )
    private val C_TYPES = setOf(
        "bool", "char", "double", "float", "int", "long", "short", "signed", "unsigned", "void", "size_t",
        "ssize_t", "uint8_t", "uint16_t", "uint32_t", "uint64_t", "int8_t", "int16_t", "int32_t", "int64_t",
        "std", "string", "vector", "map", "set", "shared_ptr", "unique_ptr",
    )
    private val CSHARP_KEYWORDS = setOf(
        "abstract", "as", "async", "await", "base", "break", "case", "catch", "class", "const", "continue",
        "default", "delegate", "do", "else", "enum", "event", "explicit", "extern", "finally", "fixed", "for",
        "foreach", "get", "goto", "if", "implicit", "in", "interface", "internal", "is", "lock", "namespace",
        "new", "operator", "out", "override", "params", "partial", "private", "protected", "public", "readonly",
        "record", "ref", "return", "sealed", "set", "sizeof", "stackalloc", "static", "struct", "switch",
        "this", "throw", "try", "typeof", "unchecked", "unsafe", "using", "var", "virtual", "void", "volatile",
        "while", "yield",
    )
    private val CSHARP_TYPES = setOf(
        "bool", "byte", "char", "decimal", "double", "float", "int", "long", "object", "sbyte", "short",
        "string", "uint", "ulong", "ushort", "void", "List", "Dictionary", "Task", "IEnumerable", "String",
        "Int32", "Int64",
    )
    private val SWIFT_KEYWORDS = setOf(
        "associatedtype", "class", "deinit", "enum", "extension", "fileprivate", "func", "import", "init",
        "inout", "internal", "let", "open", "operator", "private", "protocol", "public", "rethrows", "static",
        "struct", "subscript", "typealias", "var", "break", "case", "continue", "default", "defer", "do",
        "else", "fallthrough", "for", "guard", "if", "in", "repeat", "return", "switch", "throw", "where",
        "while", "as", "Any", "catch", "false", "is", "nil", "super", "self", "Self", "true", "try", "async",
        "await", "some",
    )
    private val SWIFT_TYPES = setOf(
        "Bool", "Character", "Double", "Float", "Int", "String", "Array", "Dictionary", "Set", "Optional",
        "Result", "Error", "Void",
    )
    private val SHELL_KEYWORDS = setOf(
        "if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac", "in",
        "function", "return", "exit", "local", "export", "readonly", "declare", "unset", "source", "alias",
        "echo", "cd", "set", "shift", "trap", "eval", "exec",
    )
    private val SQL_KEYWORDS = setOf(
        "SELECT", "FROM", "WHERE", "INSERT", "INTO", "VALUES", "UPDATE", "SET", "DELETE", "CREATE", "TABLE",
        "ALTER", "DROP", "INDEX", "VIEW", "JOIN", "LEFT", "RIGHT", "INNER", "OUTER", "FULL", "ON", "AS", "AND",
        "OR", "NOT", "NULL", "IS", "IN", "EXISTS", "BETWEEN", "LIKE", "GROUP", "BY", "ORDER", "HAVING",
        "LIMIT", "OFFSET", "DISTINCT", "UNION", "ALL", "CASE", "WHEN", "THEN", "ELSE", "END", "PRIMARY", "KEY",
        "FOREIGN", "REFERENCES", "DEFAULT", "CASCADE", "BEGIN", "COMMIT", "ROLLBACK", "WITH", "RETURNING",
        "select", "from", "where", "insert", "into", "values", "update", "set", "delete", "create", "table",
        "join", "on", "and", "or", "not", "null", "is", "in", "group", "by", "order", "limit", "as",
    )
    private val SQL_TYPES = setOf(
        "INT", "INTEGER", "BIGINT", "SMALLINT", "TEXT", "VARCHAR", "CHAR", "BOOLEAN", "BOOL", "DATE",
        "TIMESTAMP", "NUMERIC", "DECIMAL", "REAL", "DOUBLE", "BLOB", "SERIAL", "UUID", "JSON", "JSONB",
        "int", "integer", "text", "varchar", "boolean", "timestamp",
    )
}
