#include "common.h"
#include <commctrl.h>
static int clicked=0,changes=0;
static LRESULT CALLBACK parent_proc(HWND h,UINT m,WPARAM w,LPARAM l){if(m==WM_COMMAND){if(LOWORD(w)==101 && HIWORD(w)==BN_CLICKED)clicked++;if(LOWORD(w)==102&&HIWORD(w)==EN_CHANGE)changes++;return 0;}return DefWindowProcA(h,m,w,l);}
void mainCRTStartup(void){
 INITCOMMONCONTROLSEX ex={sizeof(ex),ICC_STANDARD_CLASSES|ICC_PROGRESS_CLASS};REQUIRE(InitCommonControlsEx(&ex));
 ex.dwSize=7;REQUIRE(!InitCommonControlsEx(&ex));ex.dwSize=8;ex.dwICC=0x80000000;REQUIRE(!InitCommonControlsEx(&ex));
 InitCommonControls();
 WNDCLASSA wc={0};wc.lpfnWndProc=parent_proc;wc.lpszClassName="ControlsParent";REQUIRE(RegisterClassA(&wc));
 HWND parent=CreateWindowExA(0,"ControlsParent","Controls",WS_VISIBLE,0,0,400,300,0,0,0,0);REQUIRE(parent);
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
 SendMessageA(scroll,SBM_SETRANGE,0,10);SendMessageA(scroll,SBM_SETPOS,7,TRUE);REQUIRE(SendMessageA(scroll,SBM_GETPOS,0,0)==7);
 SendMessageA(progress,PBM_SETPOS,55,0);REQUIRE(SendMessageA(progress,PBM_GETPOS,0,0)==55);
 REQUIRE(UpdateWindow(parent));REQUIRE(UpdateWindow(button));REQUIRE(UpdateWindow(edit));REQUIRE(UpdateWindow(list));
 REQUIRE(DestroyWindow(edit));REQUIRE(!IsWindow(edit));REQUIRE(DestroyWindow(parent));REQUIRE(!IsWindow(button));
 SAY("SUCCESS COMMON_CONTROLS_STATE_MESSAGES_NOTIFICATIONS\n");ExitProcess(0);
}
