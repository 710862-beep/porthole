#define DIRECTDRAW_VERSION 0x0300
#include "common.h"
#include <ddraw.h>
#include <commctrl.h>
static int clicked=0,changes=0;
static LRESULT CALLBACK parent_proc(HWND h,UINT m,WPARAM w,LPARAM l){if(m==WM_COMMAND){if(LOWORD(w)==101 && HIWORD(w)==BN_CLICKED)clicked++;if(LOWORD(w)==102&&HIWORD(w)==EN_CHANGE)changes++;return 0;}return DefWindowProcA(h,m,w,l);}
/* Authored regression for the Wine-derived modeless dialog path. */
static int dialogInit=0,dialogCommand=0;
static INT_PTR CALLBACK dialog_proc(HWND h,UINT m,WPARAM w,LPARAM l){
 if(m==WM_INITDIALOG){REQUIRE(l==0x123abc);REQUIRE((HWND)w==GetDlgItem(h,1));REQUIRE(SetDlgItemTextA(h,102,"wine"));dialogInit++;return TRUE;}
 if(m==WM_COMMAND){if(LOWORD(w)==1)dialogCommand++;return TRUE;}return FALSE;
}
static BYTE dialogBytes[512];static unsigned dp;
static void word(WORD v){dialogBytes[dp++]=(BYTE)v;dialogBytes[dp++]=(BYTE)(v>>8);}
static void dword(DWORD v){word((WORD)v);word((WORD)(v>>16));}
static void align_dialog(void){while(dp&3)dialogBytes[dp++]=0;}
static void item(DWORD style,WORD id,WORD atom,const char* text){align_dialog();dword(style|WS_CHILD|WS_VISIBLE|WS_TABSTOP);dword(0);word(5);word(id==1?5:25);word(70);word(16);word(id);word(0xffff);word(atom);while(*text)word((BYTE)*text++);word(0);word(0);}
static void dialog_regression(void){
 dp=0;dword(WS_POPUP|WS_VISIBLE|WS_CAPTION);dword(0);word(2);word(0);word(0);word(120);word(80);word(0);word(0);word('D');word(0);
 item(BS_DEFPUSHBUTTON,1,0x80,"OK");item(0,102,0x81,"old");
 HWND h=CreateDialogIndirectParamA(0,(const DLGTEMPLATE*)dialogBytes,0,dialog_proc,0x123abc);REQUIRE(h&&dialogInit==1);
 REQUIRE(GetFocus()==GetDlgItem(h,1));char text[16];REQUIRE(GetDlgItemTextA(h,102,text,sizeof(text))==4);REQUIRE(text[0]=='w'&&text[3]=='e');
 SendDlgItemMessageA(h,1,BM_CLICK,0,0);REQUIRE(dialogCommand==1);
 MSG msg={0};msg.hwnd=GetDlgItem(h,1);msg.message=WM_KEYDOWN;msg.wParam=VK_TAB;REQUIRE(IsDialogMessageA(h,&msg));REQUIRE(GetFocus()==GetDlgItem(h,102));
 msg.hwnd=GetDlgItem(h,102);msg.wParam=VK_RETURN;REQUIRE(IsDialogMessageA(h,&msg));REQUIRE(dialogCommand==2);
 HWND up=CreateWindowExA(0,UPDOWN_CLASSA,"",WS_CHILD|WS_VISIBLE|UDS_SETBUDDYINT|UDS_ARROWKEYS,100,5,16,32,h,(HMENU)200,0,0);REQUIRE(up);
 SendMessageA(up,UDM_SETRANGE32,0,10);SendMessageA(up,UDM_SETBUDDY,(WPARAM)GetDlgItem(h,102),0);SendMessageA(up,UDM_SETPOS32,0,5);BOOL invalid=TRUE;REQUIRE(SendMessageA(up,UDM_GETPOS32,0,(LPARAM)&invalid)==5&&!invalid);
 SendMessageA(up,UDM_SETPOS32,0,999);REQUIRE(SendMessageA(up,UDM_GETPOS32,0,(LPARAM)&invalid)==10&&!invalid);
 SendMessageA(up,WM_KEYDOWN,VK_DOWN,0);REQUIRE(SendMessageA(up,UDM_GETPOS32,0,(LPARAM)&invalid)==9&&!invalid);
 REQUIRE(DestroyWindow(h));REQUIRE(!IsWindow(h));
 REQUIRE(!CreateDialogParamA(0,(LPCSTR)65530,0,dialog_proc,0));REQUIRE(GetLastError()==ERROR_RESOURCE_NAME_NOT_FOUND);
 REQUIRE(!CreateDialogIndirectParamA(0,0,0,dialog_proc,0));REQUIRE(GetLastError()==ERROR_INVALID_PARAMETER);
}
void mainCRTStartup(void){
 HMODULE attached=LoadLibraryA("dll-attach.dll");REQUIRE(attached);DWORD (WINAPI *count)(void)=(DWORD(WINAPI*)(void))GetProcAddress(attached,"AttachCount");REQUIRE(count&&count()==1);REQUIRE(LoadLibraryA("dll-attach.dll")==attached);REQUIRE(count()==1);REQUIRE(!LoadLibraryA("dll-fail.dll"));REQUIRE(GetLastError()==ERROR_DLL_INIT_FAILED);REQUIRE(!GetModuleHandleA("dll-fail.dll"));
 INITCOMMONCONTROLSEX ex={sizeof(ex),ICC_STANDARD_CLASSES};REQUIRE(InitCommonControlsEx(&ex));
 ex.dwSize=7;REQUIRE(!InitCommonControlsEx(&ex));ex.dwSize=8;ex.dwICC=0x80000000;REQUIRE(!InitCommonControlsEx(&ex));
 HMODULE common=LoadLibraryA("comctl32.dll");REQUIRE(common);void (WINAPI *initOrdinal)(void)=(void (WINAPI *)(void))GetProcAddress(common,(LPCSTR)17);REQUIRE(initOrdinal);initOrdinal();
 WNDCLASSA wc={0};wc.lpfnWndProc=parent_proc;wc.lpszClassName="ControlsParent";REQUIRE(RegisterClassA(&wc));
 HWND parent=CreateWindowExA(0,"ControlsParent","Controls",WS_VISIBLE,0,0,400,300,0,0,0,0);REQUIRE(parent);
 REQUIRE(!FindWindowA("NoSuchClass",0));REQUIRE(FindWindowA("ControlsParent","Controls")==parent);
 HWND ansi=CreateWindowExA(0,"ControlsParent","Windows\xae 95",0,0,0,100,100,0,0,0,0);REQUIRE(ansi);REQUIRE(FindWindowA("ControlsParent","Windows\xae 95")==ansi);REQUIRE(SetWindowTextA(ansi,"New\xae title"));REQUIRE(FindWindowA("ControlsParent","New\xae title")==ansi);REQUIRE(DestroyWindow(ansi));
 HWND button=CreateWindowExA(0,"BUTTON","Click",WS_CHILD|WS_VISIBLE|BS_AUTOCHECKBOX,5,5,100,24,parent,(HMENU)101,0,0);REQUIRE(button);
 HWND edit=CreateWindowExA(0,"EDIT","abc",WS_CHILD|WS_VISIBLE|ES_AUTOHSCROLL,5,35,180,24,parent,(HMENU)102,0,0);REQUIRE(edit);
 HWND stat=CreateWindowExA(0,"STATIC","Label",WS_CHILD|WS_VISIBLE,5,65,100,20,parent,0,0,0);REQUIRE(stat);
 HWND list=CreateWindowExA(0,"LISTBOX","",WS_CHILD|WS_VISIBLE,5,90,180,70,parent,0,0,0);REQUIRE(list);
 HWND combo=CreateWindowExA(0,"COMBOBOX","",WS_CHILD|WS_VISIBLE,200,35,120,24,parent,0,0,0);REQUIRE(combo);
 HWND scroll=CreateWindowExA(0,"SCROLLBAR","",WS_CHILD|WS_VISIBLE,200,65,120,20,parent,0,0,0);REQUIRE(scroll);
 HWND progress=CreateWindowExA(0,PROGRESS_CLASSA,"",WS_CHILD|WS_VISIBLE,200,90,120,20,parent,0,0,0);REQUIRE(progress);
 REQUIRE(SendMessageA(button,BM_GETCHECK,0,0)==0);SendMessageA(button,WM_LBUTTONDOWN,0,0);SendMessageA(button,WM_LBUTTONUP,0,0);REQUIRE(clicked==1&&SendMessageA(button,BM_GETCHECK,0,0)==1);
 SendMessageA(button,BM_SETCHECK,BST_UNCHECKED,0);REQUIRE(SendMessageA(button,BM_GETCHECK,0,0)==0);
 SendMessageA(edit,EM_SETSEL,1,2);SendMessageA(edit,EM_REPLACESEL,0,(LPARAM)"XY");char text[64];REQUIRE(SendMessageA(edit,WM_GETTEXT,sizeof(text),(LPARAM)text)==4);REQUIRE(text[0]=='a'&&text[1]=='X'&&text[2]=='Y'&&text[3]=='c');
 SendMessageA(edit,WM_CHAR,'Z',0);REQUIRE(SendMessageA(edit,WM_GETTEXTLENGTH,0,0)==5);SendMessageA(edit,WM_KEYDOWN,VK_BACK,0);REQUIRE(SendMessageA(edit,WM_GETTEXTLENGTH,0,0)==4);REQUIRE(changes==3);
 SendMessageA(stat,WM_SETTEXT,0,(LPARAM)"New label");REQUIRE(SendMessageA(stat,WM_GETTEXTLENGTH,0,0)==9);
 REQUIRE(SendMessageA(list,LB_ADDSTRING,0,(LPARAM)"one")==0);REQUIRE(SendMessageA(list,LB_ADDSTRING,0,(LPARAM)"two")==1);REQUIRE(SendMessageA(list,LB_SETCURSEL,1,0)==1);REQUIRE(SendMessageA(list,LB_GETCURSEL,0,0)==1);REQUIRE(SendMessageA(list,LB_DELETESTRING,0,0)==1);REQUIRE(SendMessageA(list,LB_GETCURSEL,0,0)==0);
 REQUIRE(SendMessageA(combo,CB_ADDSTRING,0,(LPARAM)"first")==0);REQUIRE(SendMessageA(combo,CB_SETCURSEL,0,0)==0);REQUIRE(SendMessageA(combo,CB_GETCURSEL,0,0)==0);
 REQUIRE(SendMessageA(combo,CB_SETITEMDATA,0,0xdeadbeef)==1);REQUIRE(SendMessageA(combo,CB_INSERTSTRING,0,(LPARAM)"zero")==0);REQUIRE((DWORD)SendMessageA(combo,CB_GETITEMDATA,1,0)==0xdeadbeef);REQUIRE(SendMessageA(combo,CB_GETITEMDATA,99,0)==CB_ERR);REQUIRE(SendMessageA(combo,CB_GETCURSEL,0,0)==1);REQUIRE(SendMessageA(combo,CB_FINDSTRING,-1,(LPARAM)"FI")==1);REQUIRE(SendMessageA(combo,CB_FINDSTRINGEXACT,-1,(LPARAM)"fi")==CB_ERR);REQUIRE(SendMessageA(combo,CB_SELECTSTRING,-1,(LPARAM)"ZE")==0);REQUIRE(SendMessageA(combo,WM_GETTEXT,sizeof(text),(LPARAM)text)==4&&text[0]=='z');REQUIRE(SendMessageA(combo,CB_INSERTSTRING,99,(LPARAM)"bad")==CB_ERR);
 SendMessageA(scroll,SBM_SETRANGE,0,10);SendMessageA(scroll,SBM_SETPOS,7,TRUE);REQUIRE(SendMessageA(scroll,SBM_GETPOS,0,0)==7);
 SendMessageA(progress,PBM_SETPOS,55,0);REQUIRE(SendMessageA(progress,PBM_GETPOS,0,0)==55);
 HWND imageControl=CreateWindowExA(0,"STATIC","",WS_CHILD|WS_VISIBLE|SS_BITMAP,200,130,20,20,parent,0,0,0);REQUIRE(imageControl);HBITMAP image=CreateBitmap(8,8,1,1,0);REQUIRE(image);REQUIRE(SendMessageA(imageControl,STM_SETIMAGE,IMAGE_BITMAP,(LPARAM)image)==0);REQUIRE(SendMessageA(imageControl,STM_GETIMAGE,IMAGE_BITMAP,0)==(LRESULT)image);
 REQUIRE(IsWindowVisible(parent)&&IsWindowVisible(button)&&!IsWindowVisible((HWND)0x123456));HWND hidden=CreateWindowExA(0,"STATIC","",WS_CHILD,0,0,1,1,parent,0,0,0);REQUIRE(hidden&&!IsWindowVisible(hidden));HWND nested=CreateWindowExA(0,"STATIC","",WS_CHILD|WS_VISIBLE,0,0,1,1,hidden,0,0,0);REQUIRE(nested&&!IsWindowVisible(nested));
 REQUIRE(IsWindowEnabled(button));SetFocus(button);REQUIRE(!EnableWindow(button,FALSE));REQUIRE(!IsWindowEnabled(button)&&GetFocus()!=button);REQUIRE(EnableWindow(button,TRUE));REQUIRE(IsWindowEnabled(button)&&!EnableWindow(button,TRUE));REQUIRE(!EnableWindow((HWND)0x123456,FALSE)&&GetLastError()==ERROR_INVALID_WINDOW_HANDLE);
 REQUIRE(GetParent(button)==parent&&GetDlgCtrlID(button)==101);SetFocus(edit);REQUIRE(GetFocus()==edit);
 WINDOWPLACEMENT placement={0};placement.length=sizeof(placement);REQUIRE(!SetWindowPlacement(0,&placement)&&GetLastError()==ERROR_INVALID_WINDOW_HANDLE);placement.showCmd=SW_SHOWNOACTIVATE;placement.rcNormalPosition=(RECT){7,9,407,309};REQUIRE(SetWindowPlacement(parent,&placement));WINDOWPLACEMENT got={0};got.length=sizeof(got);REQUIRE(GetWindowPlacement(parent,&got)&&got.rcNormalPosition.left==7&&got.rcNormalPosition.top==9&&got.rcNormalPosition.right==407&&got.rcNormalPosition.bottom==309);placement.length=1;REQUIRE(!SetWindowPlacement(parent,&placement)&&GetLastError()==ERROR_INVALID_PARAMETER);
 REQUIRE(UpdateWindow(parent));REQUIRE(UpdateWindow(button));REQUIRE(UpdateWindow(edit));REQUIRE(UpdateWindow(list));
 HMODULE ddlib=LoadLibraryA("ddraw.dll");HRESULT(WINAPI*createDD)(void*,void**,void*)=(HRESULT(WINAPI*)(void*,void**,void*))GetProcAddress(ddlib,"DirectDrawCreate");IDirectDraw*ddraw=0;REQUIRE(createDD&&createDD(0,(void**)&ddraw,0)==0);REQUIRE(ddraw->lpVtbl->SetCooperativeLevel(ddraw,parent,DDSCL_NORMAL)==0);DDSURFACEDESC desc={0};desc.dwSize=sizeof(desc);desc.dwFlags=DDSD_CAPS|DDSD_WIDTH|DDSD_HEIGHT|DDSD_BACKBUFFERCOUNT;desc.dwWidth=16;desc.dwHeight=16;desc.dwBackBufferCount=2;desc.ddsCaps.dwCaps=DDSCAPS_COMPLEX|DDSCAPS_FLIP|DDSCAPS_OFFSCREENPLAIN;IDirectDrawSurface*front=0,*back=0,*third=0,*again=0;REQUIRE(ddraw->lpVtbl->CreateSurface(ddraw,&desc,&front,0)==0&&front);DDSCAPS request={0};REQUIRE(front->lpVtbl->GetAttachedSurface(front,&request,&back)==0&&back&&back!=front);REQUIRE(back->lpVtbl->GetAttachedSurface(back,&request,&third)==0&&third&&third!=back&&third!=front);REQUIRE(third->lpVtbl->GetAttachedSurface(third,&request,&again)==0&&again==front);
 REQUIRE(DestroyWindow(edit));REQUIRE(!IsWindow(edit));REQUIRE(DestroyWindow(parent));REQUIRE(!IsWindow(button));
 dialog_regression();
 SAY("SUCCESS COMMON_CONTROLS_STATE_MESSAGES_NOTIFICATIONS\n");ExitProcess(0);
}
