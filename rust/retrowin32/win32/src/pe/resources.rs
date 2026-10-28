//! Windows resources section:
//! https://learn.microsoft.com/en-us/windows/win32/debug/pe-format#the-rsrc-section
//!
//! Section contains a series of IMAGE_RESOURCE_DIRECTORY.
//! Each IMAGE_RESOURCE_DIRECTORY is a header followed by series of IMAGE_RESOURCE_DIRECTORY_ENTRY.
//! Each IMAGE_RESOURCE_DIRECTORY_ENTRY is a name or id and pointer to either
//! another IMAGE_RESOURCE_DIRECTORY or resource data in IMAGE_RESOURCE_DATA_ENTRY.
//! IMAGE_RESOURCE_DATA_ENTRY measures a span of data.

#![allow(non_snake_case)]
#![allow(non_camel_case_types)]

use crate::str16::Str16;
use memory::Extensions;
use std::{mem::size_of, ops::Range};

#[repr(C)]
#[derive(Debug, Clone)]
struct IMAGE_RESOURCE_DIRECTORY {
    Characteristics: u32,
    TimeDateStamp: u32,
    MajorVersion: u16,
    MinorVersion: u16,
    NumberOfNamedEntries: u16,
    NumberOfIdEntries: u16,
}
unsafe impl memory::Pod for IMAGE_RESOURCE_DIRECTORY {}

impl IMAGE_RESOURCE_DIRECTORY {
    fn entries(mem: &[u8]) -> impl Iterator<Item = IMAGE_RESOURCE_DIRECTORY_ENTRY> + '_ {
        let header = mem.get_pod::<IMAGE_RESOURCE_DIRECTORY>(0);
        let count = (header.NumberOfIdEntries + header.NumberOfNamedEntries) as u32;
        // Entries are in memory immediately after the directory.
        mem.iter_pod::<IMAGE_RESOURCE_DIRECTORY_ENTRY>(
            size_of::<IMAGE_RESOURCE_DIRECTORY>() as u32,
            count,
        )
    }
}

#[repr(C)]
#[derive(Debug, Clone)]
struct IMAGE_RESOURCE_DIRECTORY_ENTRY {
    Name: u32,
    OffsetToData: u32,
}
unsafe impl memory::Pod for IMAGE_RESOURCE_DIRECTORY_ENTRY {}

/// Top-level dir entry.
#[derive(Clone, Copy)]
#[repr(u32)]
pub enum RT {
    BITMAP = 2,
    STRING = 6,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ResourceName<'a> {
    Name(&'a Str16),
    Id(u32),
}

enum ResourceValue<'a> {
    Dir(&'a [u8]),
    Data(IMAGE_RESOURCE_DATA_ENTRY),
}

impl IMAGE_RESOURCE_DIRECTORY_ENTRY {
    fn name<'a>(&self, section: &'a [u8]) -> ResourceName<'a> {
        let is_id = self.Name >> 31 == 0;
        let val = self.Name & 0x7FFF_FFFF;
        if is_id {
            ResourceName::Id(val)
        } else {
            let len = section.get_pod::<u16>(val);
            let name = Str16::from_bytes(section.sub32(val + 2, len as u32 * 2));
            ResourceName::Name(name)
        }
    }

    fn value<'a>(&self, section: &'a [u8]) -> ResourceValue<'a> {
        let is_directory = self.OffsetToData >> 31 == 1;
        let offset = self.OffsetToData & 0x7FFF_FFFF;
        if is_directory {
            ResourceValue::Dir(&section[offset as usize..])
        } else {
            ResourceValue::Data(section.get_pod::<IMAGE_RESOURCE_DATA_ENTRY>(offset))
        }
    }
}

#[repr(C)]
#[derive(Debug, Clone)]
struct IMAGE_RESOURCE_DATA_ENTRY {
    OffsetToData: u32,
    Size: u32,
    CodePage: u32,
    Reserved: u32,
}
unsafe impl memory::Pod for IMAGE_RESOURCE_DATA_ENTRY {}

/// Look up a resource by its type/id values.
/// Returns the memory range within the image of the data.
pub fn find_resource(
    section: &[u8],
    query_type: ResourceName,
    query_id: ResourceName,
) -> Option<Range<u32>> {
    fn word(b:&[u8],p:usize)->Option<u16>{let s=b.get(p..p.checked_add(2)?)?;Some(u16::from_le_bytes([s[0],s[1]]))}
    fn dword(b:&[u8],p:usize)->Option<u32>{let s=b.get(p..p.checked_add(4)?)?;Some(u32::from_le_bytes([s[0],s[1],s[2],s[3]]))}
    fn entries(b:&[u8],off:usize)->Option<Vec<(u32,u32)>>{
        let n=word(b,off.checked_add(12)?)? as usize+word(b,off.checked_add(14)?)? as usize;
        let start=off.checked_add(16)?;b.get(start..start.checked_add(n.checked_mul(8)?)?)?;
        (0..n).map(|i|Some((dword(b,start+i*8)?,dword(b,start+i*8+4)?))).collect()
    }
    fn matches(b:&[u8],raw:u32,q:&ResourceName)->Option<bool>{
        if raw&0x80000000==0{return Some(*q==ResourceName::Id(raw))}
        let p=(raw&0x7fffffff)as usize;let len=word(b,p)? as usize;
        let chars:Vec<_>=(0..len).map(|i|word(b,p+2+i*2)).collect::<Option<Vec<_>>>()?;
        Some(match q{ResourceName::Name(n)=>n.to_string()==String::from_utf16_lossy(&chars),_=>false})
    }
    let mut offset=0usize;
    for query in [&query_type,&query_id]{
        let mut next=None;
        for (name,value) in entries(section,offset)?{if matches(section,name,query)?{if value&0x80000000==0{return None}next=Some((value&0x7fffffff)as usize);break}}
        offset=next?;
    }
    let (_,value)=entries(section,offset)?.into_iter().next()?;
    if value&0x80000000!=0{return None}
    let start=dword(section,value as usize)?;let size=dword(section,value as usize+4)?;
    Some(start..start.checked_add(size)?)
}
#[cfg(test)]mod tests{
 use super::*;
 #[test]fn missing_and_truncated_resource_sections(){for n in 0..32{assert!(find_resource(&vec![0;n],ResourceName::Id(5),ResourceName::Id(1)).is_none());}}
 #[test]fn malicious_entry_count(){let mut b=vec![0;16];b[14]=255;b[15]=255;assert!(find_resource(&b,ResourceName::Id(5),ResourceName::Id(1)).is_none());}
}
