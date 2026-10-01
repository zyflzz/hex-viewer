import os

# 扩展名到 Markdown 代码块语言标识的映射表（已全面扩展）
EXTENSION_LANG_MAP = {
    '.py': 'python',
    '.pyw': 'python',
    '.java': 'java',
    '.js': 'javascript',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.jsx': 'javascript',
    '.c': 'c',
    '.cpp': 'cpp',
    '.cc': 'cpp',
    '.cxx': 'cpp',
    '.h': 'cpp',
    '.hpp': 'cpp',
    '.go': 'go',
    '.rs': 'rust',
    '.rb': 'ruby',
    '.php': 'php',
    '.phtml': 'php',
    '.html': 'html',
    '.htm': 'html',
    '.css': 'css',
    '.scss': 'scss',
    '.sass': 'sass',
    '.less': 'less',
    '.json': 'json',
    '.jsonc': 'jsonc',
    '.md': 'markdown',
    '.markdown': 'markdown',
    '.yaml': 'yaml',
    '.yml': 'yaml',
    '.sh': 'bash',
    '.bash': 'bash',
    '.zsh': 'bash',
    '.fish': 'fish',
    '.bat': 'batch',
    '.cmd': 'batch',
    '.ps1': 'powershell',
    '.psm1': 'powershell',
    '.psd1': 'powershell',
    '.kt': 'kotlin',
    '.kts': 'kotlin',
    '.swift': 'swift',
    '.scala': 'scala',
    '.sc': 'scala',
    '.sql': 'sql',
    '.xml': 'xml',
    '.svg': 'xml',
    '.r': 'r',
    '.R': 'r',
    '.m': 'matlab',       # 常见为 MATLAB/Octave
    '.mat': 'matlab',
    '.pl': 'perl',
    '.pm': 'perl',
    '.lua': 'lua',
    '.t': 'perl',         # Perl 测试
    '.ex': 'elixir',
    '.exs': 'elixir',
    '.erl': 'erlang',
    '.hrl': 'erlang',
    '.clj': 'clojure',
    '.cljs': 'clojure',
    '.edn': 'clojure',
    '.hs': 'haskell',
    '.lhs': 'haskell',
    '.vim': 'vim',
    '.dart': 'dart',
    '.groovy': 'groovy',
    '.gvy': 'groovy',
    '.gradle': 'groovy',
    '.tf': 'hcl',
    '.tfvars': 'hcl',
    '.hcl': 'hcl',
    '.toml': 'toml',
    '.ini': 'ini',
    '.cfg': 'ini',
    '.conf': 'ini',
    '.properties': 'ini',
    '.tex': 'latex',
    '.rst': 'restructuredtext',
    '.dockerfile': 'dockerfile',
    '.Dockerfile': 'dockerfile',
    '.vue': 'vue',
    '.svelte': 'svelte',
    '.astro': 'astro',
}

# 黑名单：排除的目录名（全部小写，比较时忽略大小写）
EXCLUDE_DIRS = {
    '__pycache__',
    'node_modules',
    'bower_components',
    '.git',
    '.svn',
    '.hg',
    'venv',
    '.venv',
    'env',
    '.env',
    'virtualenv',
    '.virtualenvs',
    '.idea',
    '.vscode',
    '.settings',
    '__macosx',
    '.ds_store',
}

# 黑名单：排除的文件名（全部小写，比较时忽略大小写）
EXCLUDE_FILES = {
    '.ds_store',
    'thumbs.db',
    'desktop.ini',
	'target'，
	'assets'
}


def get_lang_from_ext(ext):
    """根据文件扩展名返回 Markdown 代码块语言标识"""
    ext = ext.lower()
    return EXTENSION_LANG_MAP.get(ext, 'plaintext')


def collect_dirs_with_extensions(root_dir, extensions):
    """
    遍历目录树，收集所有包含指定扩展名文件（直接或间接）的目录路径。
    跳过黑名单中的目录和文件。
    返回一个集合，其中每个元素是一个绝对路径。
    """
    dirs_with_files = set()
    for current_dir, dirs, files in os.walk(root_dir, topdown=True):
        # 排除黑名单目录，阻止 os.walk 进入这些目录
        dirs[:] = [d for d in dirs if d.lower() not in EXCLUDE_DIRS]

        for file in files:
            # 跳过黑名单中的文件
            if file.lower() in EXCLUDE_FILES:
                continue
            # 检查文件扩展名是否在指定列表中
            if any(file.endswith(ext) for ext in extensions):
                dirs_with_files.add(current_dir)
                # 将其所有父目录（直到根目录，但不包括根）也加入集合
                parent = os.path.dirname(current_dir)
                while parent != root_dir and parent not in dirs_with_files:
                    dirs_with_files.add(parent)
                    parent = os.path.dirname(parent)
                break  # 找到一个目标文件后即可跳出文件循环，继续下一个目录
    return dirs_with_files


def write_markdown(root_dir, output_dirs, outfile, extensions):
    """
    递归处理目录树，将目录标题和指定扩展名的文件内容写入Markdown文件。
    跳过黑名单中的目录和文件。
    """

    def process_directory(current_dir, level):
        # 如果不是根目录且当前目录不在输出集合中，则跳过
        if level > 0 and current_dir not in output_dirs:
            return

        # 输出当前目录的标题（仅当 level > 0 时）
        if level > 0:
            outfile.write('#' * level + ' ' + os.path.basename(current_dir) + '\n\n')

        # 获取当前目录下的所有条目，并分类
        try:
            items = os.listdir(current_dir)
        except PermissionError:
            return  # 跳过无权限访问的目录

        dirs = []
        files = []
        for item in items:
            # 跳过隐藏文件（点开头）
            if item.startswith('.'):
                continue
            # 跳过黑名单中的目录或文件
            if item.lower() in EXCLUDE_DIRS or item.lower() in EXCLUDE_FILES:
                continue

            item_path = os.path.join(current_dir, item)
            if os.path.isdir(item_path):
                dirs.append(item)
            else:
                # 只保留指定扩展名的文件
                if any(item.endswith(ext) for ext in extensions):
                    files.append(item)

        dirs.sort()
        files.sort()

        # 先递归处理子目录
        for d in dirs:
            subdir_path = os.path.join(current_dir, d)
            process_directory(subdir_path, level + 1)

        # 再处理当前目录下的目标文件
        for f in files:
            file_path = os.path.join(current_dir, f)
            outfile.write('#' * (level + 1) + ' ' + f + '\n')

            # 根据扩展名确定代码块语言
            _, ext = os.path.splitext(f)
            lang = get_lang_from_ext(ext)
            outfile.write(f'```{lang}\n')
            try:
                with open(file_path, 'r', encoding='utf-8') as code_file:
                    content = code_file.read()
                    outfile.write(content)
            except Exception as e:
                outfile.write(f'// 读取文件出错：{e}')
            outfile.write('\n```\n\n')

    process_directory(root_dir, 0)


def main():
    # 脚本所在目录（同时也是根目录）
    root_dir = os.path.dirname(os.path.abspath(__file__))
    output_file = os.path.join(root_dir, 'output.md')

    # ====== 在这里配置需要扫描的文件扩展名 ======
    # 默认扫描 Python 文件
    extensions = ['.tsx', '.ts', '.css', '.rs']
    # 如果需要扫描多种类型，可以这样写：
    # extensions = ['.py', '.java', '.js']
    # ========================================

    print(f'正在扫描目录：{root_dir}')
    print(f'扫描扩展名：{", ".join(extensions)}')

    output_dirs = collect_dirs_with_extensions(root_dir, extensions)
    print(f'找到 {len(output_dirs)} 个包含目标文件的目录')

    with open(output_file, 'w', encoding='utf-8') as outfile:
        write_markdown(root_dir, output_dirs, outfile, extensions)

    print(f'Markdown 文件已生成：{output_file}')


if __name__ == '__main__':
    main()