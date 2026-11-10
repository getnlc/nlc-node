#define UNICODE
#define _UNICODE
#include <windows.h>
#include <shellapi.h>
#include <cstdlib>
#include <string>
#include <vector>

static std::wstring executableDirectory() {
  wchar_t path[MAX_PATH];
  GetModuleFileNameW(nullptr, path, MAX_PATH);
  std::wstring value(path);
  return value.substr(0, value.find_last_of(L"\\/"));
}

static std::wstring localStateDirectory() {
  wchar_t localAppData[MAX_PATH];
  if (GetEnvironmentVariableW(L"LOCALAPPDATA", localAppData, MAX_PATH) == 0) return L"";
  return std::wstring(localAppData) + L"\\NLC Node";
}

static std::string readTextFile(const std::wstring& filePath) {
  HANDLE file = CreateFileW(filePath.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file == INVALID_HANDLE_VALUE) return "";
  std::vector<char> buffer(65536, '\0');
  DWORD read = 0;
  const BOOL succeeded = ReadFile(file, buffer.data(), static_cast<DWORD>(buffer.size() - 1), &read, nullptr);
  CloseHandle(file);
  return succeeded ? std::string(buffer.data(), read) : "";
}

static bool fileExists(const std::wstring& filePath) {
  const DWORD attributes = GetFileAttributesW(filePath.c_str());
  return attributes != INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_DIRECTORY) == 0;
}

static std::string readReadyRecord() {
  const std::wstring stateDirectory = localStateDirectory();
  return stateDirectory.empty() ? "" : readTextFile(stateDirectory + L"\\ready.json");
}

static bool processIsAlive(DWORD processId) {
  HANDLE process = OpenProcess(SYNCHRONIZE, FALSE, processId);
  if (process == nullptr) return false;
  const bool alive = WaitForSingleObject(process, 0) == WAIT_TIMEOUT;
  CloseHandle(process);
  return alive;
}

static bool readyRecordMatches(const std::string& record, DWORD processId, const std::string& launchId) {
  return record.find("\"state\":\"ready\"") != std::string::npos
    && record.find("\"pid\":" + std::to_string(processId)) != std::string::npos
    && record.find("\"launchId\":\"" + launchId + "\"") != std::string::npos;
}

static bool existingReadyRecordIsLive(const std::string& record) {
  const std::string marker = "\"pid\":";
  const size_t position = record.find(marker);
  if (record.find("\"state\":\"ready\"") == std::string::npos || position == std::string::npos) return false;
  const DWORD processId = static_cast<DWORD>(strtoul(record.c_str() + position + marker.length(), nullptr, 10));
  return processId > 0 && processIsAlive(processId);
}

static bool diagnosticsReportValid(const std::string& report) {
  return report.find("\"schemaVersion\": \"nlc-node.diagnostics/v1\"") != std::string::npos
    && (report.find("\"result\": \"pass\"") != std::string::npos
      || report.find("\"result\": \"fail\"") != std::string::npos)
    && report.find("\"contentSha256\":") != std::string::npos;
}

static bool diagnosticsReportPassed(const std::string& report) {
  return diagnosticsReportValid(report) && report.find("\"result\": \"pass\"") != std::string::npos;
}

static bool copyUtf8ToClipboard(const std::string& text) {
  if (text.empty()) return false;
  const int characterCount = MultiByteToWideChar(
    CP_UTF8,
    MB_ERR_INVALID_CHARS,
    text.data(),
    static_cast<int>(text.size()),
    nullptr,
    0
  );
  if (characterCount <= 0) return false;

  HGLOBAL memory = GlobalAlloc(GMEM_MOVEABLE, static_cast<SIZE_T>(characterCount + 1) * sizeof(wchar_t));
  if (memory == nullptr) return false;
  wchar_t* buffer = static_cast<wchar_t*>(GlobalLock(memory));
  if (buffer == nullptr) {
    GlobalFree(memory);
    return false;
  }
  const int converted = MultiByteToWideChar(
    CP_UTF8,
    MB_ERR_INVALID_CHARS,
    text.data(),
    static_cast<int>(text.size()),
    buffer,
    characterCount
  );
  if (converted != characterCount) {
    GlobalUnlock(memory);
    GlobalFree(memory);
    return false;
  }
  buffer[characterCount] = L'\0';
  GlobalUnlock(memory);

  bool clipboardOpened = false;
  for (int attempt = 0; attempt < 20; attempt++) {
    if (OpenClipboard(nullptr)) {
      clipboardOpened = true;
      break;
    }
    Sleep(50);
  }
  if (!clipboardOpened) {
    GlobalFree(memory);
    return false;
  }
  if (!EmptyClipboard() || SetClipboardData(CF_UNICODETEXT, memory) == nullptr) {
    CloseClipboard();
    GlobalFree(memory);
    return false;
  }
  CloseClipboard();
  return true;
}

static int runDiagnostics(bool suppressUi, bool copyReport) {
  const std::wstring stateDirectory = localStateDirectory();
  if (stateDirectory.empty()) {
    if (!suppressUi) MessageBoxW(nullptr, L"NLC Node diagnostics could not locate local application data.", L"NLC Node Diagnostics", MB_OK | MB_ICONERROR);
    return 1;
  }
  const std::wstring reportPath = stateDirectory + L"\\NLC-Node-Diagnostics.json";
  const std::wstring hostPath = executableDirectory() + L"\\NLC Node Host.exe";
  std::wstring command = L"\"" + hostPath + L"\" --diagnose";
  std::vector<wchar_t> commandLine(command.begin(), command.end());
  commandLine.push_back(L'\0');
  STARTUPINFOW startupInfo = { sizeof(STARTUPINFOW) };
  PROCESS_INFORMATION processInfo = {};
  if (!CreateProcessW(nullptr, commandLine.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, nullptr, &startupInfo, &processInfo)) {
    if (!suppressUi) MessageBoxW(nullptr, L"NLC Node diagnostics could not start.", L"NLC Node Diagnostics", MB_OK | MB_ICONERROR);
    return 1;
  }
  CloseHandle(processInfo.hThread);
  const DWORD waitResult = WaitForSingleObject(processInfo.hProcess, 60000);
  DWORD exitCode = 1;
  if (waitResult == WAIT_OBJECT_0) {
    GetExitCodeProcess(processInfo.hProcess, &exitCode);
  } else {
    TerminateProcess(processInfo.hProcess, 1);
    WaitForSingleObject(processInfo.hProcess, 5000);
  }
  CloseHandle(processInfo.hProcess);

  const std::string report = readTextFile(reportPath);
  const bool reportValid = fileExists(reportPath) && diagnosticsReportValid(report);
  const bool diagnosticsPassed = exitCode == 0 && reportValid && diagnosticsReportPassed(report);
  const bool clipboardCopied = !copyReport || (reportValid && copyUtf8ToClipboard(report));
  const bool passed = diagnosticsPassed && clipboardCopied;
  if (!suppressUi) {
    const wchar_t* message = passed
      ? L"NLC Node diagnostics passed. The proof report has been copied to your clipboard. Paste it into your conversation with the NLC agent."
      : !reportValid
        ? L"NLC Node diagnostics failed and could not create a valid proof report. Please run NLC Node Diagnostics again."
        : !clipboardCopied
          ? diagnosticsPassed
            ? L"NLC Node diagnostics passed, but the proof report could not be copied. Please run NLC Node Diagnostics again."
            : L"NLC Node diagnostics failed, but the proof report could not be copied. Please run NLC Node Diagnostics again."
        : L"NLC Node diagnostics failed. The proof report has been copied to your clipboard. Paste it into your conversation with the NLC agent.";
    MessageBoxW(nullptr, message, L"NLC Node Diagnostics", MB_OK | (passed ? MB_ICONINFORMATION : MB_ICONERROR));
  }
  return passed ? 0 : 1;
}

// ---- Piece M: tray indicator, single instance, window hook ----
// The Node window is a loopback page served by the host (piece K). WINDOW_PATH is the only place the launcher knows about it.
static const wchar_t* WINDOW_PATH = L"/";
static const wchar_t* TRAY_CLASS = L"NLCNodeTrayWindow";
static const wchar_t* TRAY_MUTEX = L"Local\\NLCNodeTray";
static const UINT WM_TRAY = WM_APP + 1;
static const UINT TIMER_REFRESH = 1;
static const UINT MENU_OPEN = 1;
static const UINT MENU_QUIT = 2;

enum class Indicator { Connected, Paused, Offline };

static std::wstring windowUrl() {
  const std::wstring stateDirectory = localStateDirectory();
  if (stateDirectory.empty()) return L"";
  const std::string record = readTextFile(stateDirectory + L"\\endpoint.json");
  const std::string marker = "\"port\":";
  const size_t position = record.find(marker);
  if (position == std::string::npos) return L"";
  const unsigned long port = strtoul(record.c_str() + position + marker.length(), nullptr, 10);
  if (port == 0 || port > 65535) return L"";
  return L"http://127.0.0.1:" + std::to_wstring(port) + WINDOW_PATH;
}

static void writeTextFile(const std::wstring& filePath, const std::string& text) {
  HANDLE file = CreateFileW(filePath.c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file == INVALID_HANDLE_VALUE) return;
  DWORD written = 0;
  WriteFile(file, text.data(), static_cast<DWORD>(text.size()), &written, nullptr);
  CloseHandle(file);
}

// Opens the Node window: an Edge app-mode window when Edge is present, otherwise the default browser.
// In verification runs it only records the address it would open, so a build machine opens no window.
static void openWindow(bool recordOnly) {
  const std::wstring url = windowUrl();
  if (url.empty()) return;
  if (recordOnly) {
    int length = WideCharToMultiByte(CP_UTF8, 0, url.c_str(), -1, nullptr, 0, nullptr, nullptr);
    std::string utf8(length > 0 ? length - 1 : 0, '\0');
    if (length > 1) WideCharToMultiByte(CP_UTF8, 0, url.c_str(), -1, &utf8[0], length, nullptr, nullptr);
    writeTextFile(localStateDirectory() + L"\\last-open.txt", utf8);
    return;
  }
  const std::wstring appArgument = L"--app=" + url;
  const HINSTANCE edge = ShellExecuteW(nullptr, L"open", L"msedge.exe", appArgument.c_str(), nullptr, SW_SHOWNORMAL);
  if (reinterpret_cast<INT_PTR>(edge) <= 32) ShellExecuteW(nullptr, L"open", url.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
}

// The host writes indicator.json ({"state":"connected"|"paused"|"offline"}) whenever the connection changes and at least every 20 seconds.
// A missing or stale file, or a host that is not running, shows as offline.
static Indicator readIndicator() {
  const std::wstring stateDirectory = localStateDirectory();
  if (stateDirectory.empty()) return Indicator::Offline;
  if (!existingReadyRecordIsLive(readReadyRecord())) return Indicator::Offline;
  const std::wstring indicatorPath = stateDirectory + L"\\indicator.json";
  WIN32_FILE_ATTRIBUTE_DATA info;
  if (!GetFileAttributesExW(indicatorPath.c_str(), GetFileExInfoStandard, &info)) return Indicator::Offline;
  FILETIME now;
  GetSystemTimeAsFileTime(&now);
  ULARGE_INTEGER written, current;
  written.LowPart = info.ftLastWriteTime.dwLowDateTime; written.HighPart = info.ftLastWriteTime.dwHighDateTime;
  current.LowPart = now.dwLowDateTime; current.HighPart = now.dwHighDateTime;
  if (current.QuadPart > written.QuadPart && (current.QuadPart - written.QuadPart) > 60ULL * 10000000ULL) return Indicator::Offline;
  const std::string record = readTextFile(indicatorPath);
  if (record.find("\"state\":\"connected\"") != std::string::npos) return Indicator::Connected;
  if (record.find("\"state\":\"paused\"") != std::string::npos) return Indicator::Paused;
  return Indicator::Offline;
}

static HICON makeDot(COLORREF color) {
  const int size = 16;
  HDC screen = GetDC(nullptr);
  HDC dc = CreateCompatibleDC(screen);
  HBITMAP colorBitmap = CreateCompatibleBitmap(screen, size, size);
  HBITMAP maskBitmap = CreateBitmap(size, size, 1, 1, nullptr);
  HGDIOBJ oldPen = SelectObject(dc, GetStockObject(NULL_PEN));
  HGDIOBJ oldBitmap = SelectObject(dc, colorBitmap);
  PatBlt(dc, 0, 0, size, size, BLACKNESS);
  HBRUSH brush = CreateSolidBrush(color);
  HGDIOBJ oldBrush = SelectObject(dc, brush);
  Ellipse(dc, 1, 1, size, size);
  SelectObject(dc, maskBitmap);
  PatBlt(dc, 0, 0, size, size, WHITENESS);
  SelectObject(dc, GetStockObject(BLACK_BRUSH));
  Ellipse(dc, 1, 1, size, size);
  SelectObject(dc, oldBrush);
  SelectObject(dc, oldBitmap);
  SelectObject(dc, oldPen);
  ICONINFO iconInfo = { TRUE, 0, 0, maskBitmap, colorBitmap };
  HICON icon = CreateIconIndirect(&iconInfo);
  DeleteObject(brush);
  DeleteObject(colorBitmap);
  DeleteObject(maskBitmap);
  DeleteDC(dc);
  ReleaseDC(nullptr, screen);
  return icon;
}

static NOTIFYICONDATAW trayIcon = {};
static HICON dotConnected = nullptr, dotPaused = nullptr, dotOffline = nullptr;
static int shownIndicator = -1;
static UINT taskbarCreatedMessage = 0;

static void showIndicator(HWND window, bool force) {
  const Indicator indicator = readIndicator();
  if (!force && static_cast<int>(indicator) == shownIndicator) return;
  shownIndicator = static_cast<int>(indicator);
  const wchar_t* text = indicator == Indicator::Connected ? L"NLC Node - connected"
    : indicator == Indicator::Paused ? L"NLC Node - paused"
    : L"NLC Node - offline";
  trayIcon.hIcon = indicator == Indicator::Connected ? dotConnected : indicator == Indicator::Paused ? dotPaused : dotOffline;
  trayIcon.uFlags = NIF_ICON | NIF_TIP | NIF_MESSAGE;
  wcsncpy_s(trayIcon.szTip, text, _TRUNCATE);
  if (!Shell_NotifyIconW(NIM_MODIFY, &trayIcon)) Shell_NotifyIconW(NIM_ADD, &trayIcon);
  SetWindowTextW(window, text);
}

static void stopHost() {
  const std::wstring hostPath = executableDirectory() + L"\\NLC Node Host.exe";
  std::wstring command = L"\"" + hostPath + L"\" --stop";
  std::vector<wchar_t> commandLine(command.begin(), command.end());
  commandLine.push_back(L'\0');
  STARTUPINFOW startupInfo = { sizeof(STARTUPINFOW) };
  PROCESS_INFORMATION processInfo = {};
  if (!CreateProcessW(nullptr, commandLine.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, nullptr, &startupInfo, &processInfo)) return;
  CloseHandle(processInfo.hThread);
  WaitForSingleObject(processInfo.hProcess, 15000);
  CloseHandle(processInfo.hProcess);
}

static LRESULT CALLBACK trayProc(HWND window, UINT message, WPARAM wParam, LPARAM lParam) {
  if (message == taskbarCreatedMessage && taskbarCreatedMessage != 0) {
    Shell_NotifyIconW(NIM_ADD, &trayIcon);
    showIndicator(window, true);
    return 0;
  }
  switch (message) {
    case WM_TIMER:
      showIndicator(window, false);
      return 0;
    case WM_TRAY:
      if (LOWORD(lParam) == WM_LBUTTONUP || LOWORD(lParam) == WM_LBUTTONDBLCLK) {
        openWindow(false);
      } else if (LOWORD(lParam) == WM_RBUTTONUP) {
        HMENU menu = CreatePopupMenu();
        AppendMenuW(menu, MF_STRING, MENU_OPEN, L"Open NLC Node");
        AppendMenuW(menu, MF_STRING, MENU_QUIT, L"Quit NLC Node");
        POINT cursor;
        GetCursorPos(&cursor);
        SetForegroundWindow(window);
        TrackPopupMenu(menu, TPM_RIGHTBUTTON, cursor.x, cursor.y, 0, window, nullptr);
        DestroyMenu(menu);
      }
      return 0;
    case WM_COMMAND:
      if (LOWORD(wParam) == MENU_OPEN) openWindow(false);
      if (LOWORD(wParam) == MENU_QUIT) { stopHost(); DestroyWindow(window); }
      return 0;
    case WM_DESTROY:
      Shell_NotifyIconW(NIM_DELETE, &trayIcon);
      PostQuitMessage(0);
      return 0;
  }
  return DefWindowProcW(window, message, wParam, lParam);
}

static int runTray(HINSTANCE instance) {
  WNDCLASSW windowClass = {};
  windowClass.lpfnWndProc = trayProc;
  windowClass.hInstance = instance;
  windowClass.lpszClassName = TRAY_CLASS;
  RegisterClassW(&windowClass);
  HWND window = CreateWindowExW(0, TRAY_CLASS, L"NLC Node", WS_OVERLAPPED, 0, 0, 0, 0, nullptr, nullptr, instance, nullptr);
  if (window == nullptr) return 1;
  dotConnected = makeDot(RGB(34, 197, 94));
  dotPaused = makeDot(RGB(148, 163, 184));
  dotOffline = makeDot(RGB(239, 68, 68));
  taskbarCreatedMessage = RegisterWindowMessageW(L"TaskbarCreated");
  trayIcon = {};
  trayIcon.cbSize = sizeof(trayIcon);
  trayIcon.hWnd = window;
  trayIcon.uID = 1;
  trayIcon.uCallbackMessage = WM_TRAY;
  trayIcon.uFlags = NIF_ICON | NIF_TIP | NIF_MESSAGE;
  trayIcon.hIcon = dotOffline;
  Shell_NotifyIconW(NIM_ADD, &trayIcon);
  showIndicator(window, true);
  SetTimer(window, TIMER_REFRESH, 2000, nullptr);
  MSG message;
  while (GetMessageW(&message, nullptr, 0, 0) > 0) {
    TranslateMessage(&message);
    DispatchMessageW(&message);
  }
  return 0;
}

static bool startHostAndWait() {
  const std::wstring hostPath = executableDirectory() + L"\\NLC Node Host.exe";
  const DWORD currentProcessId = GetCurrentProcessId();
  const ULONGLONG currentTickCount = GetTickCount64();
  const std::wstring launchId = std::to_wstring(currentProcessId) + L"-" + std::to_wstring(currentTickCount);
  const std::string launchIdUtf8 = std::to_string(currentProcessId) + "-" + std::to_string(currentTickCount);
  std::wstring command = L"\"" + hostPath + L"\" --launch-id " + launchId;
  std::vector<wchar_t> commandLine(command.begin(), command.end());
  commandLine.push_back(L'\0');
  STARTUPINFOW startupInfo = { sizeof(STARTUPINFOW) };
  PROCESS_INFORMATION processInfo = {};
  if (!CreateProcessW(nullptr, commandLine.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, nullptr, &startupInfo, &processInfo)) return false;
  CloseHandle(processInfo.hThread);
  const DWORD hostProcessId = processInfo.dwProcessId;
  CloseHandle(processInfo.hProcess);
  for (int attempt = 0; attempt < 100; attempt++) {
    if (readyRecordMatches(readReadyRecord(), hostProcessId, launchIdUtf8)) return true;
    Sleep(100);
  }
  return false;
}

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int) {
  const std::wstring currentCommandLine(GetCommandLineW());
  const bool clipboardVerificationRun = currentCommandLine.find(L"--verify-clipboard") != std::wstring::npos;
  const bool verificationRun = !clipboardVerificationRun && currentCommandLine.find(L"--verify") != std::wstring::npos;
  const bool suppressUi = verificationRun || clipboardVerificationRun;
  const bool diagnosticsRun = currentCommandLine.find(L"--diagnose") != std::wstring::npos;
  const bool backgroundRun = currentCommandLine.find(L"--background") != std::wstring::npos;
  if (diagnosticsRun) return runDiagnostics(suppressUi, !verificationRun);

  // Single instance: the second launch never starts a second host or a second tray, it shows the existing window.
  HANDLE trayMutex = nullptr;
  bool trayAlreadyRunning = false;
  if (!verificationRun) {
    trayMutex = CreateMutexW(nullptr, TRUE, TRAY_MUTEX);
    trayAlreadyRunning = GetLastError() == ERROR_ALREADY_EXISTS;
  }

  const bool hostWasRunning = existingReadyRecordIsLive(readReadyRecord());
  if (!hostWasRunning && !startHostAndWait()) {
    if (!suppressUi) MessageBoxW(nullptr, L"NLC Node could not start. Please try again.", L"NLC Node", MB_OK | MB_ICONWARNING);
    return 1;
  }

  if (verificationRun) {
    if (hostWasRunning) openWindow(true);
    return 0;
  }
  if (trayAlreadyRunning) {
    if (!backgroundRun) openWindow(false);
    return 0;
  }
  if (!backgroundRun) openWindow(false);
  return runTray(instance);
}
